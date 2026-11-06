package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	// ackIntervalBytes mirrors the browser receiver: acknowledge at least
	// every 1 MiB so the sender's 8 MiB window stays fed on fast links
	// without drowning it in ack traffic.
	ackIntervalBytes = 1024 * 1024
	// offerWait caps how long a receiver waits for the sender's file offer
	// after the relay admits it. The sender emits the offer immediately on
	// pairing, so this is generous without hanging forever.
	offerWait = 15 * time.Minute
)

// invitationPattern matches the share code pasted without a full URL:
// "<transfer-id>#v1.<master-key>".
var invitationPattern = regexp.MustCompile(`([A-Za-z0-9_-]{22})#v1\.([A-Za-z0-9_-]{43})`)

// parseInvitationInput accepts the full share URL
// (https://cd.yash0.in/s/<id>#v1.<key>), the bare "<id>#v1.<key>" code, or any
// surrounding text containing one of them (for pasted messages).
func parseInvitationInput(input string) (invitation, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return invitation{}, errors.New("missing share code or link: paste the link from `cdx send`")
	}
	if strings.Contains(trimmed, "://") || strings.Contains(trimmed, "/s/") {
		if value, err := parseInvitationURL(trimmed); err == nil {
			return value, nil
		}
	}
	match := invitationPattern.FindStringSubmatch(trimmed)
	if match == nil {
		return invitation{}, errors.New("this CD code is invalid: paste the full link from `cdx send` (it looks like https://cd.yash0.in/s/…#v1.…)")
	}
	return parseInvitationParts(match[1], match[2])
}

func parseInvitationURL(raw string) (invitation, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return invitation{}, errors.New("this CD link is invalid: paste the full link from `cdx send`")
	}
	pathMatch := regexp.MustCompile(`^/s/([A-Za-z0-9_-]{22})/?$`).FindStringSubmatch(parsed.Path)
	fragmentMatch := regexp.MustCompile(`^v1\.([A-Za-z0-9_-]{43})$`).FindStringSubmatch(parsed.Fragment)
	if pathMatch == nil || fragmentMatch == nil {
		// The link may be wrapped in surrounding text; fall back to scanning.
		if match := invitationPattern.FindStringSubmatch(raw); match != nil {
			return parseInvitationParts(match[1], match[2])
		}
		return invitation{}, errors.New("this CD link is invalid: paste the full link from `cdx send`")
	}
	return parseInvitationParts(pathMatch[1], fragmentMatch[1])
}

func parseInvitationParts(encodedID, encodedKey string) (invitation, error) {
	var value invitation
	rawID, err := base64.RawURLEncoding.DecodeString(encodedID)
	if err != nil || len(rawID) != 16 {
		return value, errors.New("this CD code is invalid: the transfer id is malformed")
	}
	rawKey, err := base64.RawURLEncoding.DecodeString(encodedKey)
	if err != nil || len(rawKey) != 32 {
		return value, errors.New("this CD code is invalid: the transfer key is malformed")
	}
	copy(value.id[:], rawID)
	copy(value.key[:], rawKey)
	return value, nil
}

// receivedFile describes a completed download for CLI output.
type receivedFile struct {
	Filename string `json:"filename"`
	Size     uint64 `json:"size"`
	Path     string `json:"path"`
}

type receiveResult struct {
	Version  int    `json:"version"`
	Filename string `json:"filename"`
	Size     uint64 `json:"size"`
	Path     string `json:"path"`
	// Files lists what a multi-file send unpacked into Path, a folder.
	Files []receivedFile `json:"files,omitempty"`
}

// parseReceivedOffer validates the sender's encrypted file offer against the
// same contract the browser receiver enforces.
func parseReceivedOffer(payload []byte) (fileOffer, uint64, error) {
	var offer fileOffer
	if err := json.Unmarshal(payload, &offer); err != nil {
		return offer, 0, errors.New("the sender offered invalid file details")
	}
	if _, err := receiveFilename(offer.Name); err != nil {
		return offer, 0, errors.New("the sender offered an unsafe filename")
	}
	if len(offer.MediaType) == 0 || len(offer.MediaType) > 127 {
		return offer, 0, errors.New("the sender offered an invalid file type")
	}
	for i := 0; i < len(offer.MediaType); i++ {
		if offer.MediaType[i] < 0x20 || offer.MediaType[i] > 0x7e {
			return offer, 0, errors.New("the sender offered an invalid file type")
		}
	}
	if matched, _ := regexp.MatchString(`^(0|[1-9][0-9]{0,19})$`, offer.Size); !matched {
		return offer, 0, errors.New("the sender offered an invalid file size")
	}
	size, err := strconv.ParseUint(offer.Size, 10, 64)
	if err != nil {
		return offer, 0, errors.New("the sender offered an invalid file size")
	}
	if offer.ChunkSize != chunkSize && offer.ChunkSize != chunkSizeLegacy {
		return offer, 0, errors.New("the sender uses unsupported transfer limits")
	}
	return offer, size, nil
}

// receiveFilename accepts one local component without repairing a wire name.
// IsLocal also rejects platform-specific names such as Windows device paths.
func receiveFilename(name string) (string, error) {
	if name == "." || !filepath.IsLocal(name) || strings.ContainsAny(name, `/\`) || !utf8.ValidString(name) || len(name) > 255 {
		return "", errors.New("the sender offered an unsafe filename")
	}
	for _, character := range name {
		if character < 0x20 || character == 0x7f {
			return "", errors.New("the sender offered an unsafe filename")
		}
	}
	return name, nil
}

type receiveDestination struct {
	root *os.Root
	dir  string
	name string
}

// resolveReceiveDest keeps the locally selected directory separate from the
// sender's single-component name. Explicit --out file paths remain local input.
// The caller owns the root until publication and cleanup are finished.
func resolveReceiveDest(offerName, out string, force bool) (*receiveDestination, error) {
	name, err := receiveFilename(offerName)
	if err != nil {
		return nil, err
	}
	dir := "."
	if out != "" {
		if info, statErr := os.Stat(out); statErr == nil && info.IsDir() {
			dir = out
		} else {
			dir, name = filepath.Dir(out), filepath.Base(out)
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("cannot write to %q: %s", dir, underlyingReason(err))
	}
	if !force {
		if _, statErr := root.Lstat(name); statErr == nil {
			_ = root.Close()
			return nil, fmt.Errorf("%q already exists: use --out <path> or --force to overwrite", filepath.Join(dir, name))
		}
	}
	return &receiveDestination{root: root, dir: dir, name: name}, nil
}

// createReceiveStaging never derives a directory or scratch name from the offer.
func createReceiveStaging(root *os.Root) (*os.File, string, error) {
	name := ".cd-" + rand.Text() + ".part"
	file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	return file, name, err
}

// receiveFile joins the relay as the receiver, accepts one file offer, and
// writes it to disk. onOffer observes the validated offer before acceptance.
func receiveFile(ctx context.Context, code, out string, force bool, onReceived func(receiveResult) error) error {
	relayBase, publicBase, err := endpointBase()
	if err != nil {
		return err
	}
	var invitation invitation
	if linked := shortCodeFromLink(code); linked != "" {
		code = linked
	}
	if isShortCode(code) {
		invitation, err = lookupShareCode(ctx, publicBase, code)
		if err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "code accepted — connecting to sender")
	} else {
		invitation, err = parseInvitationInput(code)
		if err != nil {
			return err
		}
	}
	token, err := invitation.receiverToken()
	if err != nil {
		return fmt.Errorf("prepare transfer secret: %w", err)
	}
	dialCtx, cancelDial := context.WithTimeout(ctx, 10*time.Second)
	defer cancelDial()
	connection, response, err := websocket.DefaultDialer.DialContext(dialCtx, relayBase+"/"+invitation.encodedID(), http.Header{})
	if err != nil {
		if dialCtx.Err() != nil && ctx.Err() == nil {
			return errors.New("connect to CD relay timed out: check your network and try again")
		}
		if response != nil {
			return fmt.Errorf("CD relay rejected the connection (HTTP %d): check CD_RELAY_URL ends in /ws/v1", response.StatusCode)
		}
		return fmt.Errorf("connect to CD relay: %w", friendlyRelayError(err))
	}
	defer connection.Close()
	stopOnCancel := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopOnCancel()
	connection.SetReadLimit(maxRecordBytes)

	join := map[string]string{
		"type": "join", "protocol": "cd-transfer-v1", "role": "receiver",
		"receiverToken": base64.RawURLEncoding.EncodeToString(token),
	}
	if err := connection.SetWriteDeadline(time.Now().Add(admissionWait)); err != nil {
		return err
	}
	if err := connection.WriteJSON(join); err != nil {
		return fmt.Errorf("join CD relay: %w", err)
	}

	opener, err := newOpener(invitation, senderDirection)
	if err != nil {
		return err
	}
	sealer, err := newSealer(invitation, receiverDirection)
	if err != nil {
		return err
	}

	// Wait for admission, then for the sender's offer. The link skips relay
	// events (peer-joined) and merges records from the relay and, once
	// connected, the direct path.
	if _, err := waitRelayEvent(ctx, connection, "accepted", admissionWait); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "connected — waiting for sender's file offer")
	link := newRecordLink(connection, sealer, opener, errors.New("sender disconnected (they closed the tab or lost network)"))
	defer link.close()
	link.start()
	kind, payload, err := link.next(ctx, offerWait)
	if err != nil {
		if isTimeoutError(err) {
			return errors.New("sender did not offer a file within 15m: ask them to run `cdx send` again")
		}
		return err
	}
	if kind != kindOffer {
		return errors.New("the sender sent a message out of order")
	}
	offer, size, err := parseReceivedOffer(payload)
	if err != nil {
		return err
	}
	var dest *receiveDestination
	if offer.Bundle {
		// Both the archive and its extracted files use this same open root.
		dir, dirErr := resolveBundleDir(out)
		if dirErr != nil {
			return dirErr
		}
		root, rootErr := os.OpenRoot(dir)
		if rootErr != nil {
			return fmt.Errorf("cannot write to %q: %s", dir, underlyingReason(rootErr))
		}
		dest = &receiveDestination{root: root, dir: dir, name: "cd-bundle.zip"}
		fmt.Fprintf(os.Stderr, "receiving several files (%s)\n", formatBytes(size))
	} else {
		if dest, err = resolveReceiveDest(offer.Name, out, force); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "receiving %s (%s)\n", offer.Name, formatBytes(size))
	}
	defer dest.root.Close()

	stagingFile, staging, err := createReceiveStaging(dest.root)
	if err != nil {
		return fmt.Errorf("cannot write to %q: %s", dest.dir, underlyingReason(err))
	}
	// Best effort cleanup of the staging file on failure; the rename below
	// moves it away on success.
	succeeded := false
	defer func() {
		_ = stagingFile.Close()
		if !succeeded {
			_ = dest.root.Remove(staging)
		}
	}()

	if err := link.send(kindAccept, nil); err != nil {
		return friendlyRelayError(fmt.Errorf("accept file offer: %w", err))
	}
	// Data starts on the relay right away; answer a direct-path offer in the
	// background and the sender moves over when the data channel opens.
	if offer.Direct != nil && directEnabled() {
		go answerDirectPath(link, offer.Direct.SDP)
	}

	terminal := isTerminal(os.Stderr)
	bar := newProgressBar(os.Stderr, "receiving", size)
	bar.jsonLines = jsonProgress && !terminal
	reportProgress := func(received uint64) {
		if terminal || bar.jsonLines {
			bar.update(received)
		}
	}

	var received uint64
	var chunks uint32
	var acknowledged uint64
	for {
		kind, payload, err = link.next(ctx, transferIdle)
		if err != nil {
			bar.finish()
			if isTimeoutError(err) {
				return errors.New("transfer stalled: no data for 90s (network or sender too slow)")
			}
			return err
		}
		switch kind {
		case kindChunk:
			if len(payload) == 0 || received+uint64(len(payload)) > size {
				bar.finish()
				return errors.New("the sender sent more data than promised")
			}
			if _, err := stagingFile.Write(payload); err != nil {
				bar.finish()
				return fmt.Errorf("write file while receiving: %s", underlyingReason(err))
			}
			received += uint64(len(payload))
			chunks++
			reportProgress(received)
			if received-acknowledged >= ackIntervalBytes || received == size {
				if err := link.send(kindAck, encodeCounts(chunks, received)); err != nil {
					bar.finish()
					return friendlyRelayError(fmt.Errorf("acknowledge file data: %w", err))
				}
				acknowledged = received
			}
		case kindEnd:
			bar.finish()
			endChunks, endBytes, err := decodeCounts(payload)
			if err != nil || endBytes != size || endBytes != received || endChunks != chunks {
				return errors.New("the transfer ended before the complete file arrived")
			}
			if err := stagingFile.Sync(); err != nil {
				return fmt.Errorf("save file while receiving: %s", underlyingReason(err))
			}
			if offer.Bundle {
				succeeded = true
				return finishBundle(link, dest, stagingFile, staging, force, offer.Name, size, chunks, received, onReceived)
			}
			if err := stagingFile.Close(); err != nil {
				return fmt.Errorf("save file while receiving: %s", underlyingReason(err))
			}
			if err := publishReceivedFile(dest.root, staging, dest.name, force); err != nil {
				return fmt.Errorf("save received file: %s", underlyingReason(err))
			}
			if err := link.send(kindComplete, encodeCounts(chunks, received)); err != nil {
				return friendlyRelayError(fmt.Errorf("verify transfer: %w", err))
			}
			link.finish(true)
			final := filepath.Join(dest.dir, dest.name)
			abs, _ := filepath.Abs(final)
			if abs == "" {
				abs = final
			}
			fmt.Fprintf(os.Stderr, "received %s (%s) — saved to %s\n", offer.Name, formatBytes(size), abs)
			succeeded = true
			if onReceived != nil {
				return onReceived(receiveResult{Version: 1, Filename: offer.Name, Size: size, Path: abs})
			}
			return nil
		default:
			bar.finish()
			return errors.New("the sender sent a message out of order")
		}
	}
}

// finishBundle confirms delivery, then unpacks the received zip so each file
// lands on its own. If unpacking fails the zip is kept, so nothing is lost.
func finishBundle(link *recordLink, dest *receiveDestination, archive *os.File, staging string, force bool, name string, size uint64, chunks uint32, received uint64, onReceived func(receiveResult) error) error {
	if err := link.send(kindComplete, encodeCounts(chunks, received)); err != nil {
		_ = archive.Close()
		_ = dest.root.Remove(staging)
		return friendlyRelayError(fmt.Errorf("verify transfer: %w", err))
	}
	link.finish(true)
	files, err := unpackBundleFile(archive, dest.root, dest.dir, force)
	if closeErr := archive.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		kept := staging
		if publishReceivedFile(dest.root, staging, dest.name, false) == nil {
			kept = dest.name
		}
		abs, _ := filepath.Abs(filepath.Join(dest.dir, kept))
		fmt.Fprintf(os.Stderr, "kept the files as one zip: %s\n", abs)
		return err
	}
	_ = dest.root.Remove(staging)
	abs, _ := filepath.Abs(dest.dir)
	if abs == "" {
		abs = dest.dir
	}
	noun := "files"
	if len(files) == 1 {
		noun = "file"
	}
	fmt.Fprintf(os.Stderr, "received %d %s (%s) — saved to %s\n", len(files), noun, formatBytes(size), abs)
	for _, file := range files {
		fmt.Fprintf(os.Stderr, "  %s\n", file.Filename)
	}
	if onReceived != nil {
		return onReceived(receiveResult{Version: 1, Filename: name, Size: size, Path: abs, Files: files})
	}
	return nil
}

// publishReceivedFile refuses destination races without --force. The staging
// file is in the destination directory, so no cross-device copy is needed.
func publishReceivedFile(root *os.Root, staging, final string, force bool) error {
	if force {
		return root.Rename(staging, final)
	}
	if err := root.Link(staging, final); err != nil {
		return err
	}
	return root.Remove(staging)
}

// answerDirectPath answers the sender's direct-path offer with a signal
// record, then trickles each local ICE candidate in its own signal record,
// so the answer waits for no STUN round trip. Any failure leaves the
// transfer on the relay.
func answerDirectPath(link *recordLink, offerSDP string) {
	path, err := newDirectPath(link.directRecord, link.directLost)
	if err != nil {
		return
	}
	link.attachDirect(path)
	// Candidates found before the answer is sent wait for it: the sender
	// can only add candidates after applying the answer.
	var mutex sync.Mutex
	answered := false
	var early []webrtc.ICECandidateInit
	sendCandidate := func(candidate webrtc.ICECandidateInit) {
		signal, err := json.Marshal(directSignal{Candidate: &candidate})
		if err == nil {
			_ = link.send(kindSignal, signal)
		}
	}
	answer, err := path.answerOffer(offerSDP, func(candidate webrtc.ICECandidateInit) {
		mutex.Lock()
		defer mutex.Unlock()
		if !answered {
			early = append(early, candidate)
			return
		}
		sendCandidate(candidate)
	})
	if err != nil {
		return
	}
	signal, err := json.Marshal(directSignal{SDP: answer})
	if err != nil || link.send(kindSignal, signal) != nil {
		return
	}
	mutex.Lock()
	answered = true
	for _, candidate := range early {
		sendCandidate(candidate)
	}
	early = nil
	mutex.Unlock()
	select {
	case <-path.opened:
		fmt.Fprintf(os.Stderr, "switched to a direct connection (%s)\n", path.route())
	case <-path.lost:
	}
}
