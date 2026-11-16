package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gorilla/websocket"
)

type relayCountedConn struct {
	net.Conn
	writes atomic.Uint64
}

func (connection *relayCountedConn) Write(data []byte) (int, error) {
	connection.writes.Add(1)
	return connection.Conn.Write(data)
}

// Count real TCP writes below WebSocket masking/framing, excluding HTTP setup.
// Buffer sizing changes framing, never the encrypted application record.
func relayBufferedSockets(t testing.TB, writeBuffer int) (*websocket.Conn, *websocket.Conn, *relayCountedConn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			accepted <- peer
		}
	}))
	t.Cleanup(server.Close)
	dialer := *websocket.DefaultDialer
	if writeBuffer < 0 {
		dialer = *newRelayDialer()
	} else {
		dialer.WriteBufferSize = writeBuffer
	}
	var counted *relayCountedConn
	dialer.NetDialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		counted = &relayCountedConn{Conn: connection}
		return counted, nil
	}
	client, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-accepted
	t.Cleanup(func() { client.Close(); peer.Close() })
	counted.writes.Store(0)
	return client, peer, counted
}

func TestRelayWriteBufferPreservesEncryptedRecord(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	want, err := sealer.sealInto(nil, kindChunk, bytes.Repeat([]byte{0xa5}, largeChunkSize))
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{4096, -1, 64 * 1024, 256 * 1024} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			client, peer, counted := relayBufferedSockets(t, size)
			done := make(chan error, 1)
			go func() { done <- client.WriteMessage(websocket.BinaryMessage, want) }()
			kind, got, err := peer.ReadMessage()
			if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(got, want) {
				t.Fatalf("WebSocket changed the encrypted record: kind=%d error=%v", kind, err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if size == 4096 && counted.writes.Load() < 128 || (size < 0 || size >= 64*1024) && counted.writes.Load() > 16 {
				t.Fatalf("unexpected TCP write count: buffer=%d writes=%d", size, counted.writes.Load())
			}
			if size < 0 && counted.writes.Load() != 1 {
				t.Fatalf("production dialer fragmented one legal record into %d writes", counted.writes.Load())
			}
		})
	}
}

func BenchmarkRelayWriteBuffer(b *testing.B) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	record, err := sealer.sealInto(nil, kindChunk, make([]byte, largeChunkSize))
	if err != nil {
		b.Fatal(err)
	}
	for _, size := range []int{4096, 64 * 1024, 256 * 1024} {
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			client, peer, counted := relayBufferedSockets(b, size)
			done := make(chan error, 1)
			go func() {
				for range b.N {
					kind, reader, err := peer.NextReader()
					if err != nil {
						done <- err
						return
					}
					n, err := io.Copy(io.Discard, reader)
					if err != nil || kind != websocket.BinaryMessage || n != int64(len(record)) {
						done <- fmt.Errorf("changed record length %d or kind %d: %v", n, kind, err)
						return
					}
				}
				done <- nil
			}()
			b.SetBytes(int64(len(record)))
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if err := client.WriteMessage(websocket.BinaryMessage, record); err != nil {
					b.Fatal(err)
				}
			}
			if err := <-done; err != nil {
				b.Fatal(err)
			}
			b.StopTimer()
			b.ReportMetric(float64(counted.writes.Load())/float64(b.N), "writes/record")
		})
	}
}
