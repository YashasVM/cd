package main

import (
	"bytes"
	"context"
	"errors"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// relayReuseConn discards writes only after a real WebSocket handshake. This
// keeps allocation measurements local to sendReleasable, without a concurrent
// relay reader allocating message buffers. Round trips use linkedPair instead.
type relayReuseConn struct {
	net.Conn
	discard bool
	onWrite func([]byte) (int, error)
	closed  chan struct{}
	once    sync.Once
}

func (connection *relayReuseConn) Write(data []byte) (int, error) {
	if connection.onWrite != nil {
		return connection.onWrite(data)
	}
	if connection.discard {
		return len(data), nil
	}
	return connection.Conn.Write(data)
}

func (connection *relayReuseConn) Close() error {
	connection.once.Do(func() { close(connection.closed) })
	if connection.Conn != nil {
		return connection.Conn.Close()
	}
	return nil
}

func (connection *relayReuseConn) SetWriteDeadline(deadline time.Time) error {
	if connection.Conn == nil {
		return nil
	}
	return connection.Conn.SetWriteDeadline(deadline)
}

func relayReuseLink(t testing.TB) (*recordLink, *relayReuseConn) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	peers := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		peer, err := upgrader.Upgrade(writer, request, nil)
		if err == nil {
			peers <- peer
		}
	}))
	t.Cleanup(server.Close)
	var transport *relayReuseConn
	dialer := *websocket.DefaultDialer
	dialer.NetDialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		transport = &relayReuseConn{Conn: connection, closed: make(chan struct{})}
		return transport, nil
	}
	connection, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-peers
	t.Cleanup(func() { _ = connection.Close(); _ = peer.Close() })
	transport.discard = true
	sealer, _ := newSealer(testInvitation(), senderDirection)
	opener, _ := newOpener(testInvitation(), receiverDirection)
	return newRecordLink(connection, sealer, opener, errors.New("peer left")), transport
}

func TestRelaySendBufferReusesStorageAndPreservesQueuedPlaintext(t *testing.T) {
	sender, receiver, _ := linkedPair(t)
	var first *byte
	var payloads [][]byte
	for index, size := range []int{largeChunkSize, 0, 17, chunkSize, largeChunkSize} {
		payload := bytes.Repeat([]byte{byte(index + 1)}, size)
		payloads = append(payloads, payload)
		if err := sender.send(kindChunk, payload); err != nil {
			t.Fatal(err)
		}
		if len(sender.sendBuffer) == 0 || cap(sender.sendBuffer) > maxRecordBytes {
			t.Fatalf("relay send buffer length/capacity = %d/%d", len(sender.sendBuffer), cap(sender.sendBuffer))
		}
		if first == nil {
			first = &sender.sendBuffer[0]
		} else if first != &sender.sendBuffer[0] {
			t.Fatal("smaller relay records did not reuse the first allocation")
		}
	}
	var retainedPlaintext [][]byte
	for _, want := range payloads {
		kind, got, err := receiver.next(context.Background(), time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(got, want) {
			t.Fatalf("relay plaintext changed: kind=%v, err=%v", kind, err)
		}
		retainedPlaintext = append(retainedPlaintext, got)
	}
	for index, got := range retainedPlaintext {
		if !bytes.Equal(got, payloads[index]) {
			t.Fatal("a later read overwrote retained plaintext")
		}
	}
	for _, payload := range [][]byte{encodeCounts(1, 10), nil, encodeCounts(2, 20)} {
		if err := receiver.send(kindAck, payload); err != nil {
			t.Fatal(err)
		}
		if _, got, err := sender.next(context.Background(), time.Second); err != nil || !bytes.Equal(got, payload) {
			t.Fatalf("reverse control record changed: %v", err)
		}
	}
}

func TestRelaySendBufferPendingDirectKeepsReplayOwnership(t *testing.T) {
	for _, loseDuringWrite := range []bool{false, true} {
		t.Run(map[bool]string{false: "replay", true: "lost during write"}[loseDuringWrite], func(t *testing.T) {
			link, transport := relayReuseLink(t)
			if err := link.send(kindChunk, bytes.Repeat([]byte{0}, 64)); err != nil {
				t.Fatal(err)
			}
			cached := link.sendBuffer
			path := &directPath{opened: make(chan struct{}), lost: make(chan struct{})}
			link.attachDirect(path)
			if loseDuringWrite {
				transport.onWrite = func(data []byte) (int, error) {
					path.lostOnce.Do(func() { close(path.lost) })
					return len(data), nil
				}
			}
			if err := link.sendReleasable(kindChunk, []byte("first"), 5); err != nil {
				t.Fatal(err)
			}
			if link.sendBuffer != nil || len(link.retained) != 1 {
				t.Fatal("pending-direct record was cached or not retained")
			}
			first := link.retained[0].record
			if len(cached) == 0 || &first[0] != &cached[0] {
				t.Fatal("cached relay buffer was not transferred to replay ownership")
			}
			snapshot := bytes.Clone(first)
			if err := link.sendReleasable(kindChunk, []byte("second"), 11); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(first, snapshot) {
				t.Fatal("a later send overwrote a pending replay record")
			}
			if loseDuringWrite {
				if len(link.retained) != 0 || len(link.sendBuffer) == 0 {
					t.Fatal("lost pending path did not return to unretained relay writes")
				}
				return
			}
			var replayed [][]byte
			path.stream = &relayReuseConn{closed: make(chan struct{}), onWrite: func(data []byte) (int, error) {
				replayed = append(replayed, bytes.Clone(data))
				return len(data), nil
			}}
			close(path.opened)
			if err := link.send(kindChunk, []byte("third")); err != nil {
				t.Fatal(err)
			}
			opener, _ := newOpener(testInvitation(), senderDirection)
			opener.sequence = 1 // The initial warm-up record already crossed the relay.
			if len(replayed) != 3 || len(link.retained) != 0 {
				t.Fatalf("replayed %d records; retained %d", len(replayed), len(link.retained))
			}
			for index, want := range []string{"first", "second", "third"} {
				if _, got, err := opener.open(replayed[index]); err != nil || string(got) != want {
					t.Fatalf("replayed record %d changed: %v", index, err)
				}
			}
		})
	}
}

func TestRelaySendBufferStripedQueueAndFallbackOwnRecords(t *testing.T) {
	link, _ := relayReuseLink(t)
	if err := link.send(kindChunk, bytes.Repeat([]byte{0}, 64)); err != nil {
		t.Fatal(err)
	}
	cached := link.sendBuffer
	link.stripe = newStriper() // No writer goroutines: keep queued records alive.
	for index, payload := range []string{"first", "second", "third"} {
		if err := link.sendReleasable(kindChunk, []byte(payload), uint64(index+1)); err != nil {
			t.Fatal(err)
		}
		if link.sendBuffer != nil {
			t.Fatal("an asynchronous striped record was cached")
		}
	}
	first := <-link.stripe.data
	if len(cached) == 0 || &first.record[0] != &cached[0] {
		t.Fatal("cached relay buffer was not transferred to the striped queue")
	}
	link.stripe.relayUnacked = []stripeItem{first, <-link.stripe.data, <-link.stripe.data}
	link.relayFailed()
	if err := link.sendReleasable(kindChunk, []byte("control"), math.MaxUint64); err != nil {
		t.Fatal(err)
	}
	opener, _ := newOpener(testInvitation(), senderDirection)
	opener.sequence = 1
	for _, want := range []string{"first", "second", "third", "control"} {
		record := <-link.stripe.control
		if _, got, err := opener.open(record); err != nil || string(got) != want {
			t.Fatalf("striped fallback record changed: %v", err)
		}
	}
}

func TestRelaySendBufferFailureAndCancellationConsumeNonce(t *testing.T) {
	for _, cancelWrite := range []bool{false, true} {
		t.Run(map[bool]string{false: "write error", true: "cancelled write"}[cancelWrite], func(t *testing.T) {
			link, transport := relayReuseLink(t)
			if err := link.send(kindChunk, bytes.Repeat([]byte{0}, 64)); err != nil {
				t.Fatal(err)
			}
			before := link.sealer.sequence
			started := make(chan struct{})
			writeError := errors.New("injected write failure")
			transport.onWrite = func([]byte) (int, error) {
				close(started)
				if cancelWrite {
					<-transport.closed
				}
				return 0, writeError
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stop := context.AfterFunc(ctx, func() { _ = link.connection.Close() })
			defer stop()
			done := make(chan error, 1)
			go func() { done <- link.send(kindChunk, []byte("failed")) }()
			<-started
			if cancelWrite {
				cancel()
			}
			select {
			case err := <-done:
				if !errors.Is(err, writeError) {
					t.Fatalf("send error = %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("cancelled write did not unblock")
			}
			if link.sendBuffer != nil || link.sealer.sequence != before+1 {
				t.Fatal("failed write cached storage or rolled back its nonce")
			}
		})
	}
}

func TestRelaySendBufferRetainedCapacityIsBounded(t *testing.T) {
	link, _ := relayReuseLink(t)
	// slices.Grow can overallocate, so check capacity rather than record length.
	link.sendBuffer = make([]byte, 0, maxRecordBytes+1)
	if err := link.send(kindChunk, nil); err != nil {
		t.Fatal(err)
	}
	if link.sendBuffer != nil {
		t.Fatal("relay cached a backing allocation larger than the record limit")
	}
	if err := link.send(kindChunk, make([]byte, maxRecordBytes-headerBytes-recordTagBytes)); err != nil {
		t.Fatal(err)
	}
	if len(link.sendBuffer) != maxRecordBytes || cap(link.sendBuffer) > maxRecordBytes {
		t.Fatalf("maximum relay record retained capacity = %d", cap(link.sendBuffer))
	}
}

func TestRelaySendBufferConcurrentSenders(t *testing.T) {
	sender, receiver, _ := linkedPair(t)
	var writers sync.WaitGroup
	for index := range 16 {
		writers.Add(1)
		go func() {
			defer writers.Done()
			if err := sender.send(kindChunk, bytes.Repeat([]byte{byte(index)}, 1024)); err != nil {
				t.Error(err)
			}
		}()
	}
	writers.Wait()
	seen := make(map[byte]bool)
	for range 16 {
		_, payload, err := receiver.next(context.Background(), time.Second)
		if err != nil || len(payload) != 1024 || !bytes.Equal(payload, bytes.Repeat(payload[:1], 1024)) || seen[payload[0]] {
			t.Fatalf("concurrent send changed a record: %v", err)
		}
		seen[payload[0]] = true
	}
}

func BenchmarkRelaySendStorage(b *testing.B) {
	for _, drop := range []bool{false, true} {
		b.Run(map[bool]string{false: "reuse", true: "drop"}[drop], func(b *testing.B) {
			link, _ := relayReuseLink(b)
			payload := make([]byte, largeChunkSize)
			if err := link.send(kindChunk, payload); err != nil {
				b.Fatal(err)
			}
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if drop {
					link.sendBuffer = nil
				}
				if err := link.send(kindChunk, payload); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
