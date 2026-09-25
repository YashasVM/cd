package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// ackIntervalBytes mirrors the browser receiver: acknowledge at least
	// every 256 KiB so the sender's 1 MiB window stays fed on fast links.
	ackIntervalBytes = 256 * 1024
	// offerWait caps how long a receiver waits for the sender's file offer
	// after the relay admits it. The sender emits the offer immediately on
	// pairing, so this is generous without hanging forever.
	offerWait = 15 * time.Minute
)

// invitationPattern matches the share code pasted without a full URL:
// "<transfer-id>#v1.<master-key>".
var invitationPattern = regexp.MustCompile(`([A-Za-z0-9_-]{22})#v1\.([A-Za-z0-9_-]{43})`)

// parseInvitationInput accepts the full share URL
// (https://cdx.yash0.in/s/<id>#v1.<key>), the bare "<id>#v1.<key>" code, or any
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
		return invitation{}, errors.New("this CD code is invalid: paste the full link from `cdx send` (it looks like https://cdx.yash0.in/s/…#v1.…)")
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
}

// parseReceivedOffer validates the sender's encrypted file offer against the
// same contract the browser receiver enforces.
func parseReceivedOffer(payload []byte) (fileOffer, uint64, error) {
	var offer fileOffer
	if err := json.Unmarshal(payload, &offer); err != nil {
		return offer, 0, errors.New("the sender offered invalid file details")
	}
	if _, err := safeFilename(offer.Name); err != nil {
		return offer, 0, errors.New("the sender offered an unsafe filename")
	}
	// safeFilename takes the basename, so a crafted offer like "../evil"
	// would slip through. The wire name itself must already be clean.
	for _, character := range offer.Name {
		if character == '\\' || character == '/' || character < 0x20 || character == 0x7f {
			return offer, 0, errors.New("the sender offered an unsafe filename")
		}
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
	if offer.ChunkSize != chunkSize {
		return offer, 0, errors.New("the sender uses unsupported transfer limits")
	}
	return offer, size, nil
}

// resolveReceiveDest maps the offer filename (or --out) to a final path and a
// staging temp path in the same directory. It refuses to overwrite unless
// force is set.
func resolveReceiveDest(offerName, out string, force bool) (final, staging string, err error) {
	name, err := safeFilename(offerName)
	if err != nil {
		return "", "", errors.New("the sender offered an unsafe filename")
	}
	final = out
	if final == "" {
		final = name
	} else {
		if info, statErr := os.Stat(final); statErr == nil && info.IsDir() {
			final = filepath.Join(final, name)
		}
	}
	if !force {
		if _, statErr := os.Lstat(final); statErr == nil {
			return "", "", fmt.Errorf("%q already exists: use --out <path> or --force to overwrite", final)
		}
	}
	dir := filepath.Dir(final)
	if dir != "." && dir != "" {
		if info, statErr := os.Stat(dir); statErr != nil || !info.IsDir() {
			return "", "", fmt.Errorf("cannot write to %q: directory does not exist", dir)
		}
	}
	staging = final + ".cd-part"
	if _, statErr := os.Lstat(staging); statErr == nil && !force {
		return "", "", fmt.Errorf("%q already exists from an interrupted download: remove it or use --force", staging)
	}
	return final, staging, nil
}

// receiveFile joins the relay as the receiver, accepts one file offer, and
// writes it to disk. onOffer observes the validated offer before acceptance.
func receiveFile(ctx context.Context, code, out string, force bool, onReceived func(receiveResult) error) error {
	relayBase, publicBase, err := endpointBase()
	if err != nil {
		return err
	}
	var invitation invitation
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

	// Wait for admission, then for the sender's offer. Text frames are relay
	// events (accepted / peer-joined); binary frames are encrypted records.
	if err := waitRelayEvent(ctx, connection, "accepted", admissionWait); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "connected — waiting for sender's file offer")
	kind, payload, err := readReceiverRecord(ctx, connection, opener, offerWait)
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
	final, staging, err := resolveReceiveDest(offer.Name, out, force)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "receiving %s (%s)\n", offer.Name, formatBytes(size))

	stagingFile, err := os.OpenFile(staging, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("cannot write %q: %s", staging, underlyingReason(err))
	}
	// Best effort cleanup of the staging file on failure; the rename below
	// moves it away on success.
	succeeded := false
	defer func() {
		_ = stagingFile.Close()
		if !succeeded {
			_ = os.Remove(staging)
		}
	}()

	if err := writeReceiverRecord(connection, sealer, kindAccept, nil); err != nil {
		return friendlyRelayError(fmt.Errorf("accept file offer: %w", err))
	}

	terminal := isTerminal(os.Stderr)
	reportProgress := func(received, total uint64) {
		if total == 0 || !terminal {
			return
		}
		percent := float64(received) / float64(total) * 100
		fmt.Fprintf(os.Stderr, "\rreceived %s / %s (%.1f%%)", formatShortBytes(received), formatShortBytes(total), percent)
	}

	var received uint64
	var chunks uint32
	var acknowledged uint64
	for {
		kind, payload, err = readReceiverRecord(ctx, connection, opener, transferIdle)
		if err != nil {
			if terminal && received > 0 {
				fmt.Fprintln(os.Stderr)
			}
			if isTimeoutError(err) {
				return errors.New("transfer stalled: no data for 45s (network or sender too slow)")
			}
			return err
		}
		switch kind {
		case kindChunk:
			if len(payload) == 0 || received+uint64(len(payload)) > size {
				if terminal && received > 0 {
					fmt.Fprintln(os.Stderr)
				}
				return errors.New("the sender sent more data than promised")
			}
			if _, err := stagingFile.Write(payload); err != nil {
				if terminal && received > 0 {
					fmt.Fprintln(os.Stderr)
				}
				return fmt.Errorf("write file while receiving: %s", underlyingReason(err))
			}
			received += uint64(len(payload))
			chunks++
			reportProgress(received, size)
			if received-acknowledged >= ackIntervalBytes || received == size {
				if err := writeReceiverRecord(connection, sealer, kindAck, encodeCounts(chunks, received)); err != nil {
					if terminal && received > 0 {
						fmt.Fprintln(os.Stderr)
					}
					return friendlyRelayError(fmt.Errorf("acknowledge file data: %w", err))
				}
				acknowledged = received
			}
		case kindEnd:
			if terminal && size > 0 {
				fmt.Fprintln(os.Stderr)
			}
			endChunks, endBytes, err := decodeCounts(payload)
			if err != nil || endBytes != size || endBytes != received || endChunks != chunks {
				return errors.New("the transfer ended before the complete file arrived")
			}
			if err := stagingFile.Sync(); err != nil {
				return fmt.Errorf("save file while receiving: %s", underlyingReason(err))
			}
			if err := stagingFile.Close(); err != nil {
				return fmt.Errorf("save file while receiving: %s", underlyingReason(err))
			}
			if force {
				_ = os.Remove(final)
			}
			if err := os.Rename(staging, final); err != nil {
				// Cross-device rename fallback: copy then remove.
				if copyErr := copyFile(staging, final); copyErr != nil {
					return fmt.Errorf("save received file: %s", underlyingReason(err))
				}
				_ = os.Remove(staging)
			}
			if err := writeReceiverRecord(connection, sealer, kindComplete, encodeCounts(chunks, received)); err != nil {
				return friendlyRelayError(fmt.Errorf("verify transfer: %w", err))
			}
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
			if terminal && received > 0 {
				fmt.Fprintln(os.Stderr)
			}
			return errors.New("the sender sent a message out of order")
		}
	}
}

// readReceiverRecord reads one encrypted sender record, skipping relay text
// events (accepted / peer-joined). A peer-left event means the sender is gone.
func readReceiverRecord(ctx context.Context, connection *websocket.Conn, opener *recordOpener, timeout time.Duration) (messageKind, []byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return 0, nil, err
		}
		if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return 0, nil, err
		}
		messageType, data, err := connection.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return 0, nil, ctx.Err()
			}
			return 0, nil, friendlyRelayError(fmt.Errorf("receive from CD: %w", err))
		}
		if messageType == websocket.TextMessage {
			var value relayEvent
			if json.Unmarshal(data, &value) == nil {
				switch value.Type {
				case "accepted", "peer-joined":
					continue
				case "peer-left":
					return 0, nil, errors.New("sender disconnected (they closed the tab or lost network)")
				}
			}
			return 0, nil, errors.New("CD relay sent unexpected text (transfer aborted)")
		}
		if messageType != websocket.BinaryMessage {
			return 0, nil, errors.New("CD relay sent an invalid frame")
		}
		kind, plaintext, err := opener.open(data)
		if err != nil {
			return 0, nil, fmt.Errorf("the sender sent invalid transfer data: %w", err)
		}
		return kind, plaintext, nil
	}
}

func writeReceiverRecord(connection *websocket.Conn, sealer *recordSealer, kind messageKind, payload []byte) error {
	record, err := sealer.seal(kind, payload)
	if err != nil {
		return err
	}
	if err := connection.SetWriteDeadline(time.Now().Add(transferIdle)); err != nil {
		return err
	}
	return connection.WriteMessage(websocket.BinaryMessage, record)
}

func copyFile(source, dest string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	buffer := make([]byte, 128*1024)
	for {
		count, readErr := in.Read(buffer)
		if count > 0 {
			if _, writeErr := out.Write(buffer[:count]); writeErr != nil {
				return writeErr
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return readErr
		}
	}
	return out.Sync()
}
