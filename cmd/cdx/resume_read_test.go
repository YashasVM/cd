package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func resumeReadTestPair(t testing.TB, dir direction) (*resumeSession, *websocket.Conn, *resumeRecordSealer) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			accepted <- socket
		}
	}))
	t.Cleanup(server.Close)
	client, _, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http:", "ws:", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	var peer *websocket.Conn
	select {
	case peer = <-accepted:
	case <-time.After(5 * time.Second):
		t.Fatal("WebSocket upgrade did not finish")
	}
	t.Cleanup(func() { _ = peer.Close() })
	client.SetReadLimit(maxRecordBytes)
	sealer, err := newResumeSealer(testInvitation(), make([]byte, 32), make([]byte, 32), dir)
	if err != nil {
		t.Fatal(err)
	}
	opener, err := newResumeOpener(testInvitation(), make([]byte, 32), make([]byte, 32), dir)
	if err != nil {
		t.Fatal(err)
	}
	return &resumeSession{socket: client, open: opener}, peer, sealer
}

func TestResumeSessionReadChunkAllocations(t *testing.T) {
	session, peer, sealer := resumeReadTestPair(t, senderDirection)
	payload := bytes.Repeat([]byte{0x5a}, chunkSize)
	record, err := sealer.seal(kindChunk, payload)
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		for range requests {
			if err := peer.WriteMessage(websocket.BinaryMessage, record); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	defer func() {
		close(requests)
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	measure := func(read func() (messageKind, []byte, error)) float64 {
		return testing.AllocsPerRun(20, func() {
			// Reuse the encrypted fixture only to isolate the read path. Normal
			// sequence progression is covered by the round-trip tests below.
			session.open.sequence = 0
			requests <- struct{}{}
			kind, got, err := read()
			if err != nil || kind != kindChunk || !bytes.Equal(got, payload) {
				t.Fatalf("read chunk: kind=%d, error=%v", kind, err)
			}
		})
	}
	legacy := measure(func() (messageKind, []byte, error) {
		_, data, err := session.socket.ReadMessage()
		if err != nil {
			return 0, nil, err
		}
		return session.open.open(data)
	})
	allocations := measure(session.next)
	// Compare on the same connection so platform-specific socket bookkeeping
	// is shared. Require only part of the observed reduction, not an exact
	// count tied to one OS or Go release.
	if allocations > legacy-8 {
		t.Fatalf("full chunk allocated %.0f times versus legacy %.0f; want at least 8 fewer allocations", allocations, legacy)
	}
	t.Logf("full chunk read: %.0f allocations versus legacy %.0f", allocations, legacy)
}

type resumeReadResult struct {
	kind messageKind
	data []byte
	err  error
}

func resumeReadTestReceive(t *testing.T, session *resumeSession, peer *websocket.Conn, send func() error) resumeReadResult {
	t.Helper()
	_ = peer.SetWriteDeadline(time.Now().Add(5 * time.Second))
	sent := make(chan error, 1)
	go func() { sent <- send() }()
	result := make(chan resumeReadResult, 1)
	go func() {
		kind, data, err := session.next()
		result <- resumeReadResult{kind, data, err}
	}()
	select {
	case got := <-result:
		select {
		case err := <-sent:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("test writer did not finish")
		}
		return got
	case <-time.After(5 * time.Second):
		session.close()
		t.Fatal("record read did not finish")
		return resumeReadResult{}
	}
}

// Raw server frames let tests put boundaries inside the record header and
// interrupt an unfinished message without relying on Gorilla's write buffering.
func resumeReadTestFrame(final bool, opcode byte, payload []byte) []byte {
	header := []byte{opcode, 0}
	if final {
		header[0] |= 0x80
	}
	switch {
	case len(payload) < 126:
		header[1] = byte(len(payload))
	case len(payload) <= 65535:
		header[1] = 126
		header = binary.BigEndian.AppendUint16(header, uint16(len(payload)))
	default:
		header[1] = 127
		header = binary.BigEndian.AppendUint64(header, uint64(len(payload)))
	}
	return append(header, payload...)
}

func TestResumeSessionReadRoundTrip(t *testing.T) {
	for _, size := range []int{0, 17, chunkSize, maxRecordBytes - headerBytes - recordTagBytes} {
		for _, fragmented := range []bool{false, true} {
			t.Run(fmt.Sprintf("size=%d/fragmented=%t", size, fragmented), func(t *testing.T) {
				session, peer, sealer := resumeReadTestPair(t, senderDirection)
				payload := bytes.Repeat([]byte{0xa5}, size)
				record, err := sealer.seal(kindChunk, payload)
				if err != nil {
					t.Fatal(err)
				}
				got := resumeReadTestReceive(t, session, peer, func() error {
					if !fragmented {
						return peer.WriteMessage(websocket.BinaryMessage, record)
					}
					for index, part := range [][]byte{record[:5], record[5:headerBytes], record[headerBytes:]} {
						opcode := byte(0)
						if index == 0 {
							opcode = websocket.BinaryMessage
						}
						if _, err := peer.UnderlyingConn().Write(resumeReadTestFrame(index == 2, opcode, part)); err != nil {
							return err
						}
					}
					return nil
				})
				if got.err != nil || got.kind != kindChunk || !bytes.Equal(got.data, payload) || session.open.sequence != 1 {
					t.Fatalf("round trip: kind=%d, length=%d, sequence=%d, error=%v", got.kind, len(got.data), session.open.sequence, got.err)
				}
				// A subsequent read cannot overwrite the first returned plaintext.
				second, err := sealer.seal(kindChunk, []byte("next record"))
				if err != nil {
					t.Fatal(err)
				}
				next := resumeReadTestReceive(t, session, peer, func() error { return peer.WriteMessage(websocket.BinaryMessage, second) })
				if next.err != nil || string(next.data) != "next record" || !bytes.Equal(got.data, payload) || session.open.sequence != 2 {
					t.Fatalf("second read changed retained plaintext or sequence: %v", next.err)
				}
			})
		}
	}
}

func TestResumeSessionReadMalformedRecords(t *testing.T) {
	cases := []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{"empty", func(b []byte) []byte { return nil }},
		{"short-header", func(b []byte) []byte { return b[:headerBytes-1] }},
		{"header-only", func(b []byte) []byte { return b[:headerBytes] }},
		{"truncated-body", func(b []byte) []byte { return b[:len(b)-1] }},
		{"extra-byte", func(b []byte) []byte { return append(b, 0) }},
		{"multiple-records", func(b []byte) []byte { return append(b, b...) }},
		{"length-too-small", func(b []byte) []byte { binary.BigEndian.PutUint32(b[8:12], 0); return b }},
		{"length-too-large", func(b []byte) []byte { binary.BigEndian.PutUint32(b[8:12], uint32(maxRecordBytes)); return b }},
		{"length-uint32-max", func(b []byte) []byte { binary.BigEndian.PutUint32(b[8:12], ^uint32(0)); return b }},
		{"magic", func(b []byte) []byte { b[0] = 'X'; return b }},
		{"version", func(b []byte) []byte { b[2] = 1; return b }},
		{"direction", func(b []byte) []byte { b[3] = byte(kindAck); return b }},
		{"sequence", func(b []byte) []byte { b[7] = 1; return b }},
		{"tag", func(b []byte) []byte { b[len(b)-1] ^= 1; return b }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			session, peer, sealer := resumeReadTestPair(t, senderDirection)
			record, err := sealer.seal(kindChunk, []byte("payload"))
			if err != nil {
				t.Fatal(err)
			}
			record = tc.mutate(record)
			got := resumeReadTestReceive(t, session, peer, func() error { return peer.WriteMessage(websocket.BinaryMessage, record) })
			if got.err == nil || classifyFailure(got.err) != failureProtocol || failureGuidance(got.err) != retryNever || got.data != nil || session.open.sequence != 0 {
				t.Fatalf("malformed record changed authentication state or retry classification: %+v, sequence=%d", got, session.open.sequence)
			}
		})
	}
}

func TestResumeRecordReadBoundsBeforeBody(t *testing.T) {
	for _, advertised := range []uint32{maxRecordBytes - headerBytes - recordTagBytes + 1, ^uint32(0)} {
		header := make([]byte, headerBytes)
		binary.BigEndian.PutUint32(header[8:], advertised)
		reader := &resumeReadHeaderOnly{header: bytes.NewReader(header)}
		if _, err := readResumeRecord(reader, recordTagBytes); err == nil || classifyFailure(err) != failureProtocol || reader.bodyReads != 0 {
			t.Fatalf("unbounded length %d reached body: reads=%d, error=%v", advertised, reader.bodyReads, err)
		}
	}
}

type resumeReadHeaderOnly struct {
	header    *bytes.Reader
	bodyReads int
}

func (r *resumeReadHeaderOnly) Read(p []byte) (int, error) {
	if r.header.Len() > 0 {
		return r.header.Read(p)
	}
	r.bodyReads++
	return 0, errors.New("must reject size before reading body")
}

func TestResumeSessionReadTransportErrors(t *testing.T) {
	for _, offset := range []int{5, headerBytes + 3, headerBytes + recordTagBytes + 7} {
		for _, closeCode := range []int{0, 4410} {
			t.Run(fmt.Sprintf("offset=%d/close=%d", offset, closeCode), func(t *testing.T) {
				session, peer, sealer := resumeReadTestPair(t, senderDirection)
				record, err := sealer.seal(kindChunk, []byte("payload"))
				if err != nil {
					t.Fatal(err)
				}
				got := resumeReadTestReceive(t, session, peer, func() error {
					if _, err := peer.UnderlyingConn().Write(resumeReadTestFrame(false, websocket.BinaryMessage, record[:offset])); err != nil {
						return err
					}
					if closeCode == 0 {
						return peer.Close()
					}
					return peer.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(closeCode, "session limit"), time.Now().Add(time.Second))
				})
				wantKind, wantRetry := failureDisconnected, retrySameRequest
				if closeCode == 4410 {
					wantKind, wantRetry = failureExpired, retryNewTransfer
					if !errors.Is(got.err, errResumeSessionLimit) {
						t.Fatalf("lost session-limit cause: %v", got.err)
					}
				}
				if got.err == nil || classifyFailure(got.err) != wantKind || failureGuidance(got.err) != wantRetry || got.data != nil || session.open.sequence != 0 {
					t.Fatalf("transport error changed classification or authenticated an incomplete message: %+v", got)
				}
			})
		}
	}
}

func TestResumeSessionReadSocketLimit(t *testing.T) {
	session, peer, _ := resumeReadTestPair(t, senderDirection)
	got := resumeReadTestReceive(t, session, peer, func() error {
		// Announce an oversized WebSocket frame without sending its body.
		header := binary.BigEndian.AppendUint64([]byte{0x82, 127}, maxRecordBytes+1)
		_, err := peer.UnderlyingConn().Write(header)
		return err
	})
	if !errors.Is(got.err, websocket.ErrReadLimit) || classifyFailure(got.err) != failureDisconnected || session.open.sequence != 0 {
		t.Fatalf("socket read limit changed: %+v", got)
	}
}

func TestResumeSessionReadCancellation(t *testing.T) {
	for _, offset := range []int{5, headerBytes + 3, headerBytes + recordTagBytes + 7} {
		t.Run(fmt.Sprint(offset), func(t *testing.T) {
			session, peer, sealer := resumeReadTestPair(t, senderDirection)
			record, err := sealer.seal(kindChunk, []byte("payload"))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go func() { <-ctx.Done(); session.close() }()
			got := resumeReadTestReceive(t, session, peer, func() error {
				_, err := peer.UnderlyingConn().Write(resumeReadTestFrame(false, websocket.BinaryMessage, record[:offset]))
				cancel()
				return err
			})
			if got.err == nil || classifyFailure(got.err) != failureDisconnected || got.data != nil || session.open.sequence != 0 {
				t.Fatalf("canceled read did not unblock without authentication: %+v", got)
			}
		})
	}
}

func TestResumeSessionReadEvents(t *testing.T) {
	for _, eventType := range []string{"accepted", "exhausted", "peer-left", "invalid"} {
		t.Run(eventType, func(t *testing.T) {
			session, peer, sealer := resumeReadTestPair(t, receiverDirection)
			record, err := sealer.seal(kindAck, []byte("acknowledgment"))
			if err != nil {
				t.Fatal(err)
			}
			got := resumeReadTestReceive(t, session, peer, func() error {
				if eventType == "invalid" {
					return peer.WriteMessage(websocket.TextMessage, []byte("not JSON"))
				}
				if err := peer.WriteJSON(resumeEvent{Type: eventType, Protocol: resumeProtocol, Reason: "session_limit"}); err != nil {
					return err
				}
				if eventType == "accepted" {
					return peer.WriteMessage(websocket.BinaryMessage, record)
				}
				return nil
			})
			switch eventType {
			case "accepted":
				if got.err != nil || got.kind != kindAck || string(got.data) != "acknowledgment" {
					t.Fatalf("event followed by encrypted control: %+v", got)
				}
			case "exhausted":
				if !errors.Is(got.err, errResumeSessionLimit) {
					t.Fatal(got.err)
				}
			case "peer-left":
				if got.err == nil || classifyFailure(got.err) != failureDisconnected {
					t.Fatal(got.err)
				}
			case "invalid":
				if got.err == nil || classifyFailure(got.err) != failureProtocol {
					t.Fatal(got.err)
				}
			}
		})
	}
}

func TestResumeRecordReadPreservesTransportError(t *testing.T) {
	// io.ReadFull produces EOF/ErrUnexpectedEOF only for a short complete
	// message. A WebSocket close, including abnormal closure, must not become
	// a permanent malformed-record failure.
	for _, err := range []error{&websocket.CloseError{Code: 4410}, &websocket.CloseError{Code: websocket.CloseAbnormalClosure}, io.ErrClosedPipe} {
		_, got := readResumeRecord(resumeReadError{err}, recordTagBytes)
		if got != err {
			t.Fatalf("transport error was replaced: got %v, want %v", got, err)
		}
	}
}

type resumeReadError struct{ err error }

func (r resumeReadError) Read([]byte) (int, error) { return 0, r.err }
