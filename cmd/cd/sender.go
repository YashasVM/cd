package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	sendWindowBytes = 8 * 1024 * 1024
	admissionWait   = 10 * time.Second
	receiverWait    = 15 * time.Minute
	consentWait     = 10 * time.Minute
	transferIdle    = 90 * time.Second
)

type relayEvent struct {
	Type     string `json:"type"`
	Protocol string `json:"protocol"`
	Reason   string `json:"reason,omitempty"`
}

type fileOffer struct {
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	Size      string `json:"size"`
	ChunkSize int    `json:"chunkSize"`
}

func endpointBase() (string, string, error) {
	relay := strings.TrimRight(os.Getenv("CD_RELAY_URL"), "/")
	if relay == "" {
		relay = "wss://cd.yash0.in/ws/v1"
	}
	public := strings.TrimRight(os.Getenv("CD_PUBLIC_URL"), "/")
	if public == "" {
		public = "https://cd.yash0.in"
	}
	parsedRelay, err := url.ParseRequestURI(relay)
	if err != nil || parsedRelay.Host == "" || parsedRelay.User != nil || parsedRelay.RawQuery != "" || parsedRelay.Fragment != "" {
		return "", "", fmt.Errorf("CD_RELAY_URL %q is invalid: use wss://cd.yash0.in/ws/v1", relay)
	}
	if parsedRelay.Scheme != "ws" && parsedRelay.Scheme != "wss" {
		return "", "", fmt.Errorf("CD_RELAY_URL %q is invalid: scheme must be wss (ws only for loopback dev)", relay)
	}
	if parsedRelay.Scheme == "ws" && !isLoopbackHost(parsedRelay.Hostname()) {
		return "", "", fmt.Errorf("CD_RELAY_URL %q is invalid: plain ws is only allowed for localhost development", relay)
	}
	if parsedRelay.Path != "/ws/v1" {
		return "", "", fmt.Errorf("CD_RELAY_URL %q is invalid: path must be /ws/v1", relay)
	}
	parsedPublic, err := url.ParseRequestURI(public)
	if err != nil || parsedPublic.Host == "" || parsedPublic.User != nil || parsedPublic.RawQuery != "" || parsedPublic.Fragment != "" {
		return "", "", fmt.Errorf("CD_PUBLIC_URL %q is invalid: use https://cd.yash0.in", public)
	}
	if parsedPublic.Scheme != "http" && parsedPublic.Scheme != "https" {
		return "", "", fmt.Errorf("CD_PUBLIC_URL %q is invalid: scheme must be https (http only for loopback dev)", public)
	}
	if parsedPublic.Path != "" && parsedPublic.Path != "/" {
		return "", "", fmt.Errorf("CD_PUBLIC_URL %q is invalid: must be the site origin without a path", public)
	}
	if parsedPublic.Scheme == "http" && !isLoopbackHost(parsedPublic.Hostname()) {
		return "", "", fmt.Errorf("CD_PUBLIC_URL %q is invalid: plain http is only allowed for localhost development", public)
	}
	expectedPublicScheme := "https"
	if parsedRelay.Scheme == "ws" {
		expectedPublicScheme = "http"
	}
	if parsedPublic.Scheme != expectedPublicScheme || !strings.EqualFold(parsedRelay.Host, parsedPublic.Host) {
		return "", "", errors.New("CD_RELAY_URL and CD_PUBLIC_URL must use the same origin (host and matching ws/https scheme)")
	}
	return relay, public, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func fileMediaType(name string) string {
	if value := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); value != "" {
		if index := strings.Index(value, ";"); index >= 0 {
			value = strings.TrimSpace(value[:index])
		}
		if value != "" {
			return value
		}
	}
	return "application/octet-stream"
}

func safeFilename(path string) (string, error) {
	name := filepath.Base(path)
	if name == "" || name == "." || name == ".." || name == "/" || !utf8.ValidString(name) || len([]byte(name)) > 255 {
		return "", errors.New("filename is not safe to share")
	}
	for _, character := range name {
		if character == '\\' || character == '/' || character < 0x20 || character == 0x7f {
			return "", errors.New("filename is not safe to share")
		}
	}
	return name, nil
}

func formatBytes(size uint64) string {
	const unit = 1024
	if size < unit {
		if size == 1 {
			return "1 byte"
		}
		return fmt.Sprintf("%d bytes", size)
	}
	units := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
	value := float64(size)
	exponent := -1
	for value >= unit && exponent < len(units)-1 {
		value /= unit
		exponent++
	}
	return fmt.Sprintf("%.1f %s (%d bytes)", value, units[exponent], size)
}

// formatShortBytes is the compact form used inside live progress lines.
func formatShortBytes(size uint64) string {
	const unit = 1024
	if size < unit {
		return fmt.Sprintf("%d B", size)
	}
	units := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
	value := float64(size)
	exponent := -1
	for value >= unit && exponent < len(units)-1 {
		value /= unit
		exponent++
	}
	return fmt.Sprintf("%.1f %s", value, units[exponent])
}

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// underlyingReason unwraps *os.PathError so messages name the path once.
func underlyingReason(err error) string {
	var pathError *os.PathError
	if errors.As(err, &pathError) && pathError.Unwrap() != nil {
		return pathError.Unwrap().Error()
	}
	return err.Error()
}

// openSharedFile validates the path before opening it. The stat-first order
// matters: opening a FIFO blocks until a writer appears, so non-regular files
// must be rejected without ever calling Open on them.
func openSharedFile(path string) (*os.File, os.FileInfo, error) {
	if path == "" {
		return nil, nil, errors.New("missing file to send")
	}
	if path == "-" {
		return nil, nil, errors.New(`standard input ("-") is not supported: send one regular file`)
	}
	info, err := os.Stat(path)
	if err != nil {
		reason := underlyingReason(err)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, fmt.Errorf("cannot find %q: %s (check the path and try again)", path, reason)
		}
		if errors.Is(err, os.ErrPermission) {
			return nil, nil, fmt.Errorf("cannot read %q: %s (check file permissions)", path, reason)
		}
		return nil, nil, fmt.Errorf("cannot access %q: %s", path, reason)
	}
	if info.IsDir() {
		return nil, nil, fmt.Errorf("%q is a folder: zip it first, then send the .zip", path)
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("%q is not a regular file: send one normal file", path)
	}
	file, err := os.Open(path)
	if err != nil {
		reason := underlyingReason(err)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, fmt.Errorf("cannot find %q: %s (check the path and try again)", path, reason)
		}
		if errors.Is(err, os.ErrPermission) {
			return nil, nil, fmt.Errorf("cannot read %q: %s (check file permissions)", path, reason)
		}
		return nil, nil, fmt.Errorf("cannot open %q: %s", path, reason)
	}
	current, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, fmt.Errorf("cannot read %q: %s", path, underlyingReason(err))
	}
	if current.IsDir() || !current.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, fmt.Errorf("%q changed into a non-regular file while opening it", path)
	}
	return file, current, nil
}

func sendFile(ctx context.Context, path string, linkMode bool, onReady func(readyOutput) error) error {
	file, info, err := openSharedFile(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if info.Size() < 0 {
		return errors.New("file size is invalid")
	}
	filename, err := safeFilename(path)
	if err != nil {
		return err
	}
	relayBase, publicBase, err := endpointBase()
	if err != nil {
		return err
	}
	invitation, err := newInvitation(rand.Reader)
	if err != nil {
		return err
	}
	tokenHash, err := invitation.receiverTokenHash()
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
			return fmt.Errorf("CD relay rejected the connection (HTTP %d): check CD_RELAY_URL ends in /ws/v1 and matches CD_PUBLIC_URL", response.StatusCode)
		}
		return fmt.Errorf("connect to CD relay: %w", friendlyRelayError(err))
	}
	defer connection.Close()
	stopOnCancel := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopOnCancel()
	connection.SetReadLimit(maxRecordBytes)
	join := map[string]string{
		"type": "join", "protocol": "cd-transfer-v1", "role": "sender",
		"receiverTokenHash": base64.RawURLEncoding.EncodeToString(tokenHash),
	}
	if err := connection.SetWriteDeadline(time.Now().Add(admissionWait)); err != nil {
		return err
	}
	if err := connection.WriteJSON(join); err != nil {
		return fmt.Errorf("join CD relay: %w", err)
	}
	if err := waitRelayEvent(ctx, connection, "accepted", admissionWait); err != nil {
		return err
	}
	ready := readyOutput{
		Version:  1,
		URL:      publicBase + "/s/" + invitation.encodedID() + "#v1." + invitation.encodedKey(),
		Filename: filename, Size: uint64(info.Size()),
	}
	if linkMode {
		if err := onReady(ready); err != nil {
			return err
		}
	} else {
		code, err := claimShareCode(ctx, publicBase, invitation.encodedID(), invitation.encodedKey())
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("%s (the private-link fallback is `cd send --link`)", err)
		}
		ready.Code = code
		if err := onReady(ready); err != nil {
			return err
		}
	}
	fmt.Fprintf(os.Stderr, "sharing %s (%s) — share the code above, keep this running\n", filename, formatBytes(ready.Size))
	if ready.Size > 256*1024*1024 {
		fmt.Fprintln(os.Stderr, "note: for files over 256 MB, use desktop Chrome or Edge and make sure the receiver has enough free storage")
	}
	fmt.Fprintln(os.Stderr, "waiting for receiver (up to 15m; Ctrl-C to cancel)")
	if ready.Code != "" {
		fmt.Fprintln(os.Stderr, "receivers type the code in the browser Receive box or run: cd receive <code>")
	} else {
		fmt.Fprintln(os.Stderr, "terminal receivers: cd receive <paste-the-link-above>  ·  browsers: open the link")
	}
	if err := waitRelayEvent(ctx, connection, "peer-joined", receiverWait); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "receiver connected — sending file offer")
	return transfer(ctx, connection, file, ready, invitation)
}

// isTimeoutError reports whether err is a network deadline timeout.
func isTimeoutError(err error) bool {
	var netError net.Error
	return errors.As(err, &netError) && netError.Timeout()
}

// friendlyRelayError translates relay WebSocket close codes into actionable
// sender-side messages. Unknown errors pass through unchanged.
func friendlyRelayError(err error) error {
	var closeError *websocket.CloseError
	if !errors.As(err, &closeError) {
		return err
	}
	switch closeError.Code {
	case 4400:
		return errors.New("CD relay rejected the transfer (invalid request): update cd and try a fresh link")
	case 4401:
		return errors.New("CD relay rejected the receiver (link key mismatch): send a fresh link")
	case 4403:
		return errors.New("CD relay rejected a transfer frame (protocol mismatch): update cd and try again")
	case 4404:
		return errors.New("the other side is no longer available (they may have closed the link)")
	case 4406:
		return errors.New("CD relay rejected the protocol version: update cd and try again")
	case 4408:
		return errors.New("this CD link has expired: run `cd send` again for a fresh link")
	case 4409:
		return errors.New("this link is already claimed or expired (one receiver per link): run `cd send` again")
	case 4429:
		return errors.New("the transfer is too slow for the relay (backpressure): try again on a faster network")
	default:
		return err
	}
}

func waitRelayEvent(ctx context.Context, connection *websocket.Conn, expected string, timeout time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	messageType, data, err := connection.ReadMessage()
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if isTimeoutError(err) {
			switch expected {
			case "accepted":
				return errors.New("CD relay did not answer within 10s: check your network and try again")
			case "peer-joined":
				return errors.New("no receiver joined within 15m: the link expired, run `cd send` again")
			default:
				return fmt.Errorf("timed out waiting for relay %s", expected)
			}
		}
		return friendlyRelayError(fmt.Errorf("wait for relay %s: %w", expected, err))
	}
	if messageType != websocket.TextMessage {
		return errors.New("CD relay sent an invalid response")
	}
	var value relayEvent
	if err := json.Unmarshal(data, &value); err != nil || value.Protocol != "cd-transfer-v1" || value.Type != expected {
		actual := strings.TrimSpace(string(data))
		if len(actual) > 80 {
			actual = actual[:80] + "…"
		}
		if actual == "" {
			actual = "empty response"
		}
		return fmt.Errorf("CD relay sent %s while waiting for %s", actual, expected)
	}
	return nil
}

func transfer(ctx context.Context, connection *websocket.Conn, file *os.File, ready readyOutput, invitation invitation) error {
	sealer, err := newSealer(invitation, senderDirection)
	if err != nil {
		return err
	}
	opener, err := newOpener(invitation, receiverDirection)
	if err != nil {
		return err
	}
	offer, err := json.Marshal(fileOffer{Name: ready.Filename, MediaType: fileMediaType(ready.Filename), Size: strconv.FormatUint(ready.Size, 10), ChunkSize: chunkSize})
	if err != nil {
		return err
	}
	if err := writeRecord(connection, sealer, kindOffer, offer); err != nil {
		return friendlyRelayError(fmt.Errorf("send file offer: %w", err))
	}
	fmt.Fprintln(os.Stderr, "waiting for receiver to accept (up to 10m)")
	kind, payload, err := readRecord(ctx, connection, opener, consentWait)
	if err != nil {
		if isTimeoutError(err) {
			return errors.New("receiver did not accept within 10m: they may have closed the link, run `cd send` again")
		}
		return err
	}
	if kind != kindAccept || len(payload) != 0 {
		return errors.New("receiver sent an invalid acceptance")
	}
	fmt.Fprintln(os.Stderr, "receiver accepted — sending file")

	terminal := isTerminal(os.Stderr)
	reportProgress := func(acknowledged, total uint64) {
		if total == 0 || !terminal {
			return
		}
		percent := float64(acknowledged) / float64(total) * 100
		fmt.Fprintf(os.Stderr, "\rsent %s / %s (%.1f%%)", formatShortBytes(acknowledged), formatShortBytes(total), percent)
	}

	// Full-duplex pipeline: one reader goroutine owns the socket read side
	// and streams acks/completion into a channel while the send loop only
	// writes. The old stop-and-wait loop serialized every 1 MiB behind a
	// round trip, capping throughput near 168 KiB/s on real RTTs. With an
	// 8 MiB window and 256 KiB chunks the sender keeps up to 32 chunks in
	// flight and only blocks when the window is genuinely full.
	type inbound struct {
		kind    messageKind
		payload []byte
		err     error
	}
	incoming := make(chan inbound, 64)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			kind, payload, err := readRecord(ctx, connection, opener, transferIdle)
			select {
			case incoming <- inbound{kind: kind, payload: payload, err: err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
			if kind == kindComplete {
				return
			}
		}
	}()

	acknowledged := uint64(0)
	waitForWindow := func(sent, chunks uint64, chunks32 uint32) error {
		for sent-acknowledged >= sendWindowBytes {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case msg := <-incoming:
				if msg.err != nil {
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					if isTimeoutError(msg.err) {
						return errors.New("transfer stalled: no acknowledgement for 90s (network or receiver too slow)")
					}
					return msg.err
				}
				if msg.kind != kindAck {
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					return errors.New("receiver sent an invalid acknowledgement")
				}
				ackChunks, ackBytes, err := decodeCounts(msg.payload)
				if err != nil || ackChunks > chunks32 || ackBytes < acknowledged || ackBytes > sent {
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					return errors.New("receiver sent invalid progress")
				}
				acknowledged = ackBytes
				reportProgress(acknowledged, ready.Size)
			}
		}
		return nil
	}
	drainAcks := func(sent uint64, chunks32 uint32) error {
		for acknowledged < sent {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case msg := <-incoming:
				if msg.err != nil {
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					if isTimeoutError(msg.err) {
						return errors.New("transfer stalled: no acknowledgement for 90s (network or receiver too slow)")
					}
					return msg.err
				}
				if msg.kind == kindComplete {
					// Completion arrived early (tiny file): stash it back by
					// treating it as drained; the END phase below re-reads.
					// Simplest: put it aside via a one-slot replay.
					// We return a sentinel by pushing to a fresh channel is
					// overkill — instead validate here if it matches.
					// Fall through to ack validation; mismatch fails below.
					if len(msg.payload) == 12 {
						if cc, cb, cerr := decodeCounts(msg.payload); cerr == nil && cc == chunks32 && cb == sent {
							acknowledged = sent
							// Re-inject as completion for the END wait.
							go func() {
								select {
								case incoming <- msg:
								case <-ctx.Done():
								}
							}()
							return nil
						}
					}
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					return errors.New("receiver sent an invalid acknowledgement")
				}
				if msg.kind != kindAck {
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					return errors.New("receiver sent an invalid acknowledgement")
				}
				ackChunks, ackBytes, err := decodeCounts(msg.payload)
				if err != nil || ackChunks > chunks32 || ackBytes < acknowledged || ackBytes > sent {
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					return errors.New("receiver sent invalid progress")
				}
				acknowledged = ackBytes
				reportProgress(acknowledged, ready.Size)
			}
		}
		return nil
	}

	buffer := make([]byte, chunkSize)
	var sent uint64
	var chunks uint32
	sendErr := func() error {
		for {
			count, readErr := file.Read(buffer)
			if count > 0 {
				if err := writeRecord(connection, sealer, kindChunk, buffer[:count]); err != nil {
					if terminal && sent > 0 {
						fmt.Fprintln(os.Stderr)
					}
					return friendlyRelayError(fmt.Errorf("send file data: %w", err))
				}
				sent += uint64(count)
				chunks++
				if err := waitForWindow(sent, uint64(chunks), chunks); err != nil {
					return err
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				if terminal && sent > 0 {
					fmt.Fprintln(os.Stderr)
				}
				return fmt.Errorf("read file while sending: %w", readErr)
			}
		}
		return nil
	}()
	if sendErr != nil {
		return sendErr
	}
	if err := drainAcks(sent, chunks); err != nil {
		return err
	}
	if terminal && ready.Size > 0 {
		fmt.Fprintln(os.Stderr)
	} else if !terminal && ready.Size >= 1024*1024 {
		fmt.Fprintf(os.Stderr, "sent %s\n", formatBytes(sent))
	}
	if sent != ready.Size {
		return errors.New("file changed while it was being sent")
	}
	if err := writeRecord(connection, sealer, kindEnd, encodeCounts(chunks, sent)); err != nil {
		return friendlyRelayError(fmt.Errorf("finish transfer: %w", err))
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case msg := <-incoming:
		if msg.err != nil {
			if isTimeoutError(msg.err) {
				return errors.New("receiver did not verify within 90s: they may have disconnected")
			}
			return msg.err
		}
		completeChunks, completeBytes, countErr := decodeCounts(msg.payload)
		if msg.kind != kindComplete || countErr != nil || completeChunks != chunks || completeBytes != sent {
			return errors.New("receiver did not verify the transfer")
		}
	}
	<-readerDone
	fmt.Fprintln(os.Stderr, "receiver verified the file")
	return nil
}

func writeRecord(connection *websocket.Conn, sealer *recordSealer, kind messageKind, payload []byte) error {
	record, err := sealer.seal(kind, payload)
	if err != nil {
		return err
	}
	if err := connection.SetWriteDeadline(time.Now().Add(transferIdle)); err != nil {
		return err
	}
	return connection.WriteMessage(websocket.BinaryMessage, record)
}

func readRecord(ctx context.Context, connection *websocket.Conn, opener *recordOpener, timeout time.Duration) (messageKind, []byte, error) {
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
		if json.Unmarshal(data, &value) == nil && value.Type == "peer-left" {
			return 0, nil, errors.New("receiver disconnected (they closed the tab or lost network)")
		}
		return 0, nil, errors.New("CD relay sent unexpected text (transfer aborted)")
	}
	if messageType != websocket.BinaryMessage {
		return 0, nil, errors.New("CD relay sent an invalid frame")
	}
	return opener.open(data)
}

func encodeCounts(chunks uint32, bytes uint64) []byte {
	value := make([]byte, 12)
	binary.BigEndian.PutUint32(value[:4], chunks)
	binary.BigEndian.PutUint64(value[4:], bytes)
	return value
}

func decodeCounts(value []byte) (uint32, uint64, error) {
	if len(value) != 12 {
		return 0, 0, errors.New("invalid counter payload")
	}
	return binary.BigEndian.Uint32(value[:4]), binary.BigEndian.Uint64(value[4:]), nil
}
