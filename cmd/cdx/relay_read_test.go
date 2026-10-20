package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func relayReadSockets(t testing.TB, writeBuffer int) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{WriteBufferSize: writeBuffer}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			accepted <- connection
		}
	}))
	t.Cleanup(server.Close)
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-accepted
	t.Cleanup(func() { client.Close(); peer.Close() })
	client.SetReadLimit(maxRecordBytes)
	return client, peer
}

func TestRelayExactRecordRead(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	record, _ := sealer.sealInto(nil, kindChunk, bytes.Repeat([]byte("fragment"), 300))
	emptySealer, _ := newSealer(testInvitation(), receiverDirection)
	empty, _ := emptySealer.sealInto(nil, kindAccept, nil)
	for _, test := range []struct {
		name  string
		data  []byte
		valid bool
	}{
		{"fragmented", record, true},
		{"empty-control", empty, true},
		{"short-header", record[:5], false},
		{"short-body", record[:len(record)-1], false},
		{"trailing", append(bytes.Clone(record), 1), false},
		{"wrong-protocol", func() []byte { p := bytes.Clone(record); p[2] = 2; return p }(), false},
		{"oversize-declared", func() []byte { p := bytes.Clone(record); binary.BigEndian.PutUint32(p[8:12], maxRecordBytes); return p }(), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, peer := relayReadSockets(t, 32)
			link := &recordLink{connection: client, items: make(chan linkItem, 1), stop: make(chan struct{}), readerDone: make(chan struct{})}
			go link.readRelay()
			writer, err := peer.NextWriter(websocket.BinaryMessage)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write(test.data); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case item := <-link.items:
				if (item.err == nil) != test.valid {
					t.Fatalf("valid=%v error=%v", test.valid, item.err)
				}
				if test.valid && !bytes.Equal(item.record, test.data) {
					t.Fatal("forwarded bytes changed")
				}
			case <-time.After(time.Second):
				t.Fatal("reader did not deliver record")
			}
		})
	}
}

func TestRelayExactReadTextAndClose(t *testing.T) {
	for _, event := range []string{"peer-left", "unexpected", "close"} {
		t.Run(event, func(t *testing.T) {
			client, peer := relayReadSockets(t, 32)
			sentinel := errors.New("peer has left")
			link := &recordLink{connection: client, items: make(chan linkItem, 1), stop: make(chan struct{}), readerDone: make(chan struct{}), peerLeft: sentinel}
			go link.readRelay()
			for _, text := range []string{`{"type":"accepted"}`, `{"type":"peer-joined"}`} {
				if err := peer.WriteMessage(websocket.TextMessage, []byte(text)); err != nil {
					t.Fatal(err)
				}
			}
			if event == "close" {
				peer.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			} else {
				peer.WriteMessage(websocket.TextMessage, []byte(`{"type":"`+event+`"}`))
			}
			select {
			case item := <-link.items:
				if item.err == nil {
					t.Fatal("missing error")
				}
				if event == "peer-left" && item.err != sentinel {
					t.Fatalf("peer-left changed: %v", item.err)
				}
				if event == "close" {
					var closed *websocket.CloseError
					if !errors.As(item.err, &closed) || closed.Code != websocket.CloseNormalClosure {
						t.Fatalf("close detail lost: %v", item.err)
					}
				}
			case <-time.After(time.Second):
				t.Fatal("reader did not report event")
			}
		})
	}
}

func BenchmarkRelayRecordRead(b *testing.B) {
	for _, exact := range []bool{false, true} {
		name := "ReadMessage"
		if exact {
			name = "exact"
		}
		b.Run(name, func(b *testing.B) {
			client, peer := relayReadSockets(b, 4096)
			sealer, _ := newSealer(testInvitation(), senderDirection)
			record, err := sealer.sealInto(nil, kindChunk, make([]byte, 768<<10))
			if err != nil {
				b.Fatal(err)
			}
			link := &recordLink{connection: client, items: make(chan linkItem, 1), stop: make(chan struct{}), readerDone: make(chan struct{})}
			if exact {
				go link.readRelay()
			} else {
				go func() {
					for {
						_, p, err := client.ReadMessage()
						link.deliver(linkItem{record: p, err: err})
						if err != nil {
							return
						}
					}
				}()
			}
			done := make(chan error, 1)
			b.SetBytes(768 << 10)
			b.ReportAllocs()
			b.ResetTimer()
			go func() {
				for range b.N {
					if err := peer.WriteMessage(websocket.BinaryMessage, record); err != nil {
						done <- err
						return
					}
				}
				done <- nil
			}()
			for range b.N {
				if item := <-link.items; item.err != nil {
					b.Fatal(item.err)
				}
			}
			if err := <-done; err != nil {
				b.Fatal(err)
			}
			b.StopTimer()
			close(link.stop)
		})
	}
}
