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
	chunkSize       = 64 * 1024
	sendWindowBytes = 1024 * 1024
	admissionWait   = 10 * time.Second
	receiverWait    = 15 * time.Minute
	consentWait     = 10 * time.Minute
	transferIdle    = 45 * time.Second
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
		return value
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

func sendFile(ctx context.Context, path string, onReady func(readyOutput) error) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %q: %w (check the path and try again)", path, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("read %q: %w", path, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%q is a folder: zip it first, then send the .zip", path)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%q is not a regular file: send one normal file", path)
	}
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
			return fmt.Errorf("CD relay rejected the connection (HTTP %d)", response.StatusCode)
		}
		return fmt.Errorf("connect to CD relay: %w", err)
	}
	defer connection.Close()
	stopOnCancel := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopOnCancel()
	connection.SetReadLimit(maxRecordBytes)
	join := map[string]string{
		"type": "join", "protocol": "cd-transfer-v1", "role": "sender",
		"receiverTokenHash": base64.RawURLEncoding.EncodeToString(tokenHash),
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
	if err := onReady(ready); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "sharing %s (%d bytes) — send the link above, keep this running\n", filename, ready.Size)
	if ready.Size > 256*1024*1024 {
		fmt.Fprintln(os.Stderr, "note: for files over 256 MB, use desktop Chrome or Edge and make sure the receiver has enough free storage")
	}
	fmt.Fprintln(os.Stderr, "waiting for receiver")
	if err := waitRelayEvent(ctx, connection, "peer-joined", receiverWait); err != nil {
		return err
	}
	return transfer(ctx, connection, file, ready, invitation)
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
		return fmt.Errorf("wait for relay %s: %w", expected, err)
	}
	if messageType != websocket.TextMessage {
		return errors.New("CD relay sent an invalid response")
	}
	var value relayEvent
	if err := json.Unmarshal(data, &value); err != nil || value.Protocol != "cd-transfer-v1" || value.Type != expected {
		return fmt.Errorf("CD relay did not confirm %s", expected)
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
		return err
	}
	kind, payload, err := readRecord(ctx, connection, opener, consentWait)
	if err != nil {
		return err
	}
	if kind != kindAccept || len(payload) != 0 {
		return errors.New("receiver sent an invalid acceptance")
	}

	buffer := make([]byte, chunkSize)
	var sent uint64
	var acknowledged uint64
	var chunks uint32
	for {
		count, readErr := file.Read(buffer)
		if count > 0 {
			if err := writeRecord(connection, sealer, kindChunk, buffer[:count]); err != nil {
				return err
			}
			sent += uint64(count)
			chunks++
		}
		if sent-acknowledged >= sendWindowBytes || readErr == io.EOF {
			for acknowledged < sent {
				kind, payload, err = readRecord(ctx, connection, opener, transferIdle)
				if err != nil {
					return err
				}
				if kind != kindAck {
					return errors.New("receiver sent an invalid acknowledgement")
				}
				ackChunks, ackBytes, err := decodeCounts(payload)
				if err != nil || ackChunks > chunks || ackBytes < acknowledged || ackBytes > sent {
					return errors.New("receiver sent invalid progress")
				}
				acknowledged = ackBytes
				fmt.Fprintf(os.Stderr, "received %d/%d bytes\r", acknowledged, ready.Size)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if sent != ready.Size {
		return errors.New("file changed while it was being sent")
	}
	if err := writeRecord(connection, sealer, kindEnd, encodeCounts(chunks, sent)); err != nil {
		return err
	}
	kind, payload, err = readRecord(ctx, connection, opener, transferIdle)
	if err != nil {
		return err
	}
	completeChunks, completeBytes, countErr := decodeCounts(payload)
	if kind != kindComplete || countErr != nil || completeChunks != chunks || completeBytes != sent {
		return errors.New("receiver did not verify the transfer")
	}
	fmt.Fprintln(os.Stderr, "\nreceiver verified the file")
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
		return 0, nil, fmt.Errorf("receive from CD: %w", err)
	}
	if messageType == websocket.TextMessage {
		var value relayEvent
		if json.Unmarshal(data, &value) == nil && value.Type == "peer-left" {
			return 0, nil, errors.New("receiver disconnected")
		}
		return 0, nil, errors.New("CD relay sent unexpected text")
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
