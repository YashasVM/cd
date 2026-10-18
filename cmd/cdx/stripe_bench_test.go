package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// This comparison opens direct before timing. CLI process measurements also
// include a variable amount of relay traffic while ICE/SCTP connects.
func BenchmarkStripedWindowThroughput(b *testing.B) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	sender, receiver := stripedBenchmarkPair(b)
	senderPath, err := newDirectPath(sender.directRecord, sender.directLost)
	if err != nil {
		b.Fatal(err)
	}
	sender.attachDirect(senderPath)
	offer, err := senderPath.createOffer()
	if err != nil {
		b.Fatal(err)
	}
	receiverPath, err := newDirectPath(receiver.directRecord, receiver.directLost)
	if err != nil {
		b.Fatal(err)
	}
	receiver.attachDirect(receiverPath)
	answer, err := receiverPath.answerOffer(offer, nil)
	if err != nil {
		b.Fatal(err)
	}
	if err := senderPath.acceptAnswer(answer); err != nil {
		b.Fatal(err)
	}
	for _, path := range []*directPath{senderPath, receiverPath} {
		select {
		case <-path.opened:
		case <-time.After(10 * time.Second):
			b.Fatal("direct path did not open")
		}
	}
	sender.striping = stripeEnabled()
	chunk := make([]byte, chunkSize)
	for i := range chunk {
		chunk[i] = byte(i*31 + i/251)
	}
	const chunks = 512
	const total = chunks * chunkSize
	expected := sha256.New()
	for range chunks {
		expected.Write(chunk)
	}
	b.SetBytes(total)
	b.ResetTimer()
	for iteration := range b.N {
		base := uint64(iteration * total)
		done := make(chan error, 1)
		go func() {
			actual := sha256.New()
			for index := range chunks {
				kind, data, err := receiver.next(context.Background(), transferIdle)
				if err != nil {
					done <- err
					return
				}
				if kind != kindChunk {
					done <- fmt.Errorf("unexpected kind %d", kind)
					return
				}
				actual.Write(data)
				offset := uint64((index + 1) * chunkSize)
				if offset%(1<<20) == 0 {
					if err := receiver.send(kindAck, encodeCounts(uint32(index+1), base+offset)); err != nil {
						done <- err
						return
					}
				}
			}
			if !bytes.Equal(actual.Sum(nil), expected.Sum(nil)) {
				done <- errors.New("SHA-256 differs")
				return
			}
			done <- nil
		}()
		acknowledged := base
		ack := func(kind messageKind, payload []byte) {
			if kind != kindAck {
				b.Fatalf("expected ACK, got %d", kind)
			}
			_, count, err := decodeCounts(payload)
			if err != nil {
				b.Fatal(err)
			}
			acknowledged = count
			sender.acknowledged(count)
		}
		for index := range chunks {
			sent := base + uint64((index+1)*chunkSize)
			if err := sender.sendReleasable(kindChunk, chunk, sent); err != nil {
				b.Fatal(err)
			}
			for {
				kind, payload, ok, err := sender.poll()
				if err != nil {
					b.Fatal(err)
				}
				if !ok {
					break
				}
				ack(kind, payload)
			}
			for sent-acknowledged >= minSendWindow {
				kind, payload, err := sender.next(context.Background(), transferIdle)
				if err != nil {
					b.Fatal(err)
				}
				ack(kind, payload)
			}
		}
		for acknowledged < base+total {
			kind, payload, err := sender.next(context.Background(), transferIdle)
			if err != nil {
				b.Fatal(err)
			}
			ack(kind, payload)
		}
		if err := <-done; err != nil {
			b.Fatal(err)
		}
	}
	b.StopTimer()
	if sender.stripe != nil {
		s := sender.stripe
		s.mu.Lock()
		b.Logf("share=%f rate=%f disabled=%v", s.share, s.lastRate, reflect.ValueOf(s).Elem().FieldByName("relayDisabled"))
		s.mu.Unlock()
	}
}

func stripedBenchmarkPair(b *testing.B) (*recordLink, *recordLink) {
	b.Helper()
	upgrader := websocket.Upgrader{}
	sockets := make(chan *websocket.Conn, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			sockets <- c
		}
	}))
	b.Cleanup(server.Close)
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	left, _, err := dialRelay(context.Background(), url)
	if err != nil {
		b.Fatal(err)
	}
	right, _, err := dialRelay(context.Background(), url)
	if err != nil {
		b.Fatal(err)
	}
	serverLeft, serverRight := <-sockets, <-sockets
	b.Cleanup(func() { left.Close(); right.Close(); serverLeft.Close(); serverRight.Close() })
	var relayed atomic.Uint64
	b.Cleanup(func() { b.Logf("relay data bytes=%d", relayed.Load()) })
	type frame struct {
		kind    int
		data    []byte
		arrived time.Time
	}
	forward := func(from, to *websocket.Conn) {
		queue := make(chan frame, 32)
		go func() {
			defer close(queue)
			for {
				kind, data, err := from.ReadMessage()
				if err != nil {
					return
				}
				if from == serverLeft && kind == websocket.BinaryMessage && len(data) >= headerBytes && messageKind(data[3]) == kindChunk {
					relayed.Add(uint64(len(data)))
				}
				queue <- frame{kind, data, time.Now()}
			}
		}()
		var next time.Time
		for f := range queue {
			if os.Getenv("CD_BENCH_RELAY_SLOW") == "1" {
				next = maxTime(next, f.arrived.Add(100*time.Millisecond)).Add(time.Duration(float64(len(f.data)) / (8 * 1024 * 1024) * float64(time.Second)))
				if wait := time.Until(next); wait > 0 {
					time.Sleep(wait)
				}
			}
			if err := to.WriteMessage(f.kind, f.data); err != nil {
				return
			}
		}
	}
	go forward(serverLeft, serverRight)
	go forward(serverRight, serverLeft)
	value := testInvitation()
	ss, _ := newSealer(value, senderDirection)
	so, _ := newOpener(value, receiverDirection)
	rs, _ := newSealer(value, receiverDirection)
	ro, _ := newOpener(value, senderDirection)
	sender := newRecordLink(left, ss, so, errors.New("receiver left"))
	receiver := newRecordLink(right, rs, ro, errors.New("sender left"))
	sender.start()
	receiver.start()
	if err := sender.send(kindOffer, []byte("relay probe")); err != nil {
		b.Fatal(err)
	}
	if kind, _, err := receiver.next(context.Background(), transferIdle); err != nil || kind != kindOffer {
		b.Fatalf("probe: %d %v", kind, err)
	}
	if err := receiver.send(kindAccept, nil); err != nil {
		b.Fatal(err)
	}
	if kind, _, err := sender.next(context.Background(), transferIdle); err != nil || kind != kindAccept {
		b.Fatalf("probe answer: %d %v", kind, err)
	}
	b.Cleanup(func() { sender.close(); receiver.close() })
	return sender, receiver
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
