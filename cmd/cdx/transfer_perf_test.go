package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func TestRecordMatchesBrowserWireFixture(t *testing.T) {
	// Produced by origin/main src/agent-protocol.js with testInvitation().
	const fixture = "43440102000000000000000b6cac3fa0535fa01390738f18570971a48dabaed7ae4e6b1f763b94"
	sealer, err := newSealer(testInvitation(), senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	record, err := sealer.seal(kindChunk, []byte("exact bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(record) != fixture {
		t.Fatalf("wire record changed: %x", record)
	}
	opener, err := newOpener(testInvitation(), senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	kind, payload, err := opener.open(record)
	if err != nil || kind != kindChunk || string(payload) != "exact bytes" {
		t.Fatalf("browser fixture: %d %q %v", kind, payload, err)
	}
	if &payload[0] != &record[headerBytes] {
		t.Fatal("opener copied the owned record")
	}
}

func TestOfferDoesNotWaitForUnresponsiveSTUN(t *testing.T) {
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{{URLs: []string{"stun:" + socket.LocalAddr().String()}}}
	defer func() { directICEServers = saved }()
	path, err := newDirectPath(func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatal(err)
	}
	defer path.close()
	started := time.Now()
	offer, err := path.createOffer()
	elapsed := time.Since(started)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("offer waited %s for STUN", elapsed)
	}
	if !strings.Contains(offer, " typ host") {
		t.Fatal("offer omitted host candidates")
	}
	t.Logf("offer ready in %s with host candidates while STUN remains unanswered", elapsed)
}

func TestTransferNegotiatesSenderCandidates(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	for _, trickle := range []bool{false, true} {
		t.Run(fmt.Sprintf("receiver-trickle-%t", trickle), func(t *testing.T) {
			sender, receiver, _ := linkedPair(t)
			path, err := newDirectPath(sender.directRecord, sender.directLost)
			if err != nil {
				t.Fatal(err)
			}
			sender.attachDirect(path)
			sdp, err := path.createOffer()
			if err != nil {
				t.Fatal(err)
			}
			offerSDP := make(chan string, 1)
			offerSDP <- sdp
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			source := bytes.Repeat([]byte{19, 37, 81, 4}, chunkSize)
			done := make(chan error, 1)
			go func() {
				fail := func(err error) { done <- err }
				kind, payload, err := receiver.next(ctx, 5*time.Second)
				if err != nil || kind != kindOffer {
					fail(fmt.Errorf("offer: %d %v", kind, err))
					return
				}
				offer, _, err := parseReceivedOffer(payload)
				if err != nil || offer.Direct == nil || !offer.Direct.Trickle {
					fail(fmt.Errorf("missing sender capability: %s %v", payload, err))
					return
				}
				receiverPath, err := newDirectPath(receiver.directRecord, receiver.directLost)
				if err != nil {
					fail(err)
					return
				}
				receiver.attachDirect(receiverPath)
				answer, err := receiverPath.answerOffer(offer.Direct.SDP, nil)
				if err != nil {
					fail(err)
					return
				}
				signal, _ := json.Marshal(directSignal{SDP: answer, Trickle: trickle})
				if err := receiver.send(kindSignal, signal); err != nil {
					fail(err)
					return
				}
				if err := receiver.send(kindAccept, nil); err != nil {
					fail(err)
					return
				}
				var received []byte
				var chunks uint32
				candidates := 0
				for {
					kind, payload, err = receiver.next(ctx, 5*time.Second)
					if err != nil {
						fail(err)
						return
					}
					switch kind {
					case kindSignal:
						if !trickle {
							fail(fmt.Errorf("legacy receiver received sender SIGNAL"))
							return
						}
						var signal directSignal
						if err := json.Unmarshal(payload, &signal); err != nil || signal.Candidate == nil {
							fail(fmt.Errorf("invalid candidate: %s", payload))
							return
						}
						candidates++
						if err := receiverPath.addCandidate(*signal.Candidate); err != nil {
							fail(err)
							return
						}
					case kindChunk:
						received = append(received, payload...)
						chunks++
						if err := receiver.send(kindAck, encodeCounts(chunks, uint64(len(received)))); err != nil {
							fail(err)
							return
						}
					case kindEnd:
						if !bytes.Equal(received, source) {
							fail(fmt.Errorf("payload differs"))
							return
						}
						if trickle && candidates == 0 {
							fail(fmt.Errorf("negotiated sender sent no candidates"))
							return
						}
						if err := receiver.send(kindComplete, encodeCounts(chunks, uint64(len(received)))); err != nil {
							fail(err)
							return
						}
						receiver.finish(true)
						done <- nil
						return
					default:
						fail(fmt.Errorf("unexpected record %d", kind))
						return
					}
				}
			}()
			if err := transfer(ctx, sender, bytes.NewReader(source), readyOutput{Filename: "payload.bin", Size: uint64(len(source))}, offerSDP, sendHooks{}); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAssemblerOwnsCompletedRecords(t *testing.T) {
	sealer, err := newSealer(testInvitation(), senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	first, err := sealer.seal(kindChunk, bytes.Repeat([]byte{7}, chunkSize))
	if err != nil {
		t.Fatal(err)
	}
	second, err := sealer.seal(kindEnd, encodeCounts(1, chunkSize))
	if err != nil {
		t.Fatal(err)
	}
	var assembler recordAssembler
	var records [][]byte
	stream := append(append([]byte{}, first...), second...)
	for _, piece := range stream {
		result, err := assembler.push([]byte{piece})
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, result...)
	}
	if len(records) != 2 || !bytes.Equal(records[0], first) || !bytes.Equal(records[1], second) {
		t.Fatal("assembler reused or corrupted a completed record")
	}
	header := make([]byte, headerBytes)
	copy(header, "CD")
	header[2] = protocolVersion
	binary.BigEndian.PutUint32(header[8:], maxRecordBytes)
	if _, err := assembler.push(header); err == nil {
		t.Fatal("oversized declared length allocated")
	}
}

func TestLinkKeepsArrivalTimestamp(t *testing.T) {
	value := testInvitation()
	sealer, err := newSealer(value, receiverDirection)
	if err != nil {
		t.Fatal(err)
	}
	opener, err := newOpener(value, receiverDirection)
	if err != nil {
		t.Fatal(err)
	}
	record, err := sealer.seal(kindAck, encodeCounts(1, chunkSize))
	if err != nil {
		t.Fatal(err)
	}
	link := newRecordLink(nil, nil, opener, nil)
	arrived := time.Unix(100, 0)
	if err := link.accept(linkItem{record: record, receivedAt: arrived}); err != nil {
		t.Fatal(err)
	}
	kind, _, ok, err := link.ready()
	if err != nil || !ok || kind != kindAck || !link.receivedAt.Equal(arrived) {
		t.Fatalf("ACK arrival: %s %v", link.receivedAt, err)
	}
}

func TestRelayRecordFraming(t *testing.T) {
	sealer, err := newSealer(testInvitation(), senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	record, err := sealer.seal(kindChunk, []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := readRelayRecord(bytes.NewReader(record))
	if err != nil || !bytes.Equal(got, record) {
		t.Fatalf("read record: %x %v", got, err)
	}
	for _, bad := range [][]byte{record[:5], record[:len(record)-1], append(append([]byte{}, record...), 0)} {
		if _, err := readRelayRecord(bytes.NewReader(bad)); err == nil {
			t.Fatal("accepted truncated or trailing data")
		}
	}
	header := append([]byte{}, record[:headerBytes]...)
	binary.BigEndian.PutUint32(header[8:], ^uint32(0))
	if _, err := readRelayRecord(bytes.NewReader(header)); err == nil {
		t.Fatal("accepted oversized record header")
	}
	if _, err := readRelayRecord(bytes.NewReader(nil)); err != io.EOF {
		t.Fatalf("empty frame: %v", err)
	}
}

func BenchmarkRecordRoundTrip(b *testing.B) {
	sealer, err := newSealer(testInvitation(), senderDirection)
	if err != nil {
		b.Fatal(err)
	}
	opener, err := newOpener(testInvitation(), senderDirection)
	if err != nil {
		b.Fatal(err)
	}
	payload := bytes.Repeat([]byte{31}, chunkSize)
	b.SetBytes(chunkSize)
	b.ReportAllocs()
	for b.Loop() {
		record, err := sealer.seal(kindChunk, payload)
		if err != nil {
			b.Fatal(err)
		}
		kind, got, err := opener.open(record)
		if err != nil || kind != kindChunk || !bytes.Equal(got, payload) {
			b.Fatalf("round trip failed: %d %v", kind, err)
		}
	}
}

func TestStripedDirectDrainsWithoutAcknowledgements(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	sender, receiver, _ := linkedPair(t)
	senderPath, err := newDirectPath(sender.directRecord, sender.directLost)
	if err != nil {
		t.Fatal(err)
	}
	sender.attachDirect(senderPath)
	offer, err := senderPath.createOffer()
	if err != nil {
		t.Fatal(err)
	}
	receiverPath, err := newDirectPath(receiver.directRecord, receiver.directLost)
	if err != nil {
		t.Fatal(err)
	}
	receiver.attachDirect(receiverPath)
	answer, err := receiverPath.answerOffer(offer, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := senderPath.acceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, path := range []*directPath{senderPath, receiverPath} {
		select {
		case <-path.opened:
		case <-time.After(5 * time.Second):
			t.Fatal("direct path did not open")
		}
	}
	sender.stripe = newStriper()
	// Run only the direct writer with the full direct buffer capacity.
	// No ACKs arrive to wake it; each restart must come from buffer drainage.
	go sender.writeDirect(senderPath)
	const records = 64
	for index := range records {
		if err := sender.sendReleasable(kindChunk, bytes.Repeat([]byte{byte(index)}, chunkSize), uint64(index+1)*chunkSize); err != nil {
			t.Fatal(err)
		}
	}
	for index := range records {
		kind, payload, err := receiver.next(context.Background(), 5*time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(payload, bytes.Repeat([]byte{byte(index)}, chunkSize)) {
			t.Fatalf("record %d: kind %d: %v", index, kind, err)
		}
	}
	// Simulate a final relay record that never arrives. END must flush its
	// retained ciphertext on direct even though no further ACK or data wakes it.
	orphan, err := sender.sealer.seal(kindChunk, []byte("last relay record"))
	if err != nil {
		t.Fatal(err)
	}
	sender.stripe.mu.Lock()
	sender.stripe.relayUnacked = append(sender.stripe.relayUnacked, stripeItem{record: orphan, release: 99 << 20})
	sender.stripe.relayBytes += uint64(len(orphan))
	sender.stripe.mu.Unlock()
	if err := sender.send(kindEnd, []byte("done")); err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"last relay record", "done"} {
		kind, payload, err := receiver.next(context.Background(), time.Second)
		expectedKind := kindChunk
		if i == 1 {
			expectedKind = kindEnd
		}
		if err != nil || kind != expectedKind || string(payload) != want {
			t.Fatalf("final record %d: kind %d, payload %q, error %v", i, kind, payload, err)
		}
	}

}

type countedRelayConn struct {
	net.Conn
	writes *atomic.Uint64
}

func (connection countedRelayConn) Write(payload []byte) (int, error) {
	connection.writes.Add(1)
	return connection.Conn.Write(payload)
}

func TestRelayChunkUsesOneSocketWrite(t *testing.T) {
	var writes atomic.Uint64
	saved := websocket.DefaultDialer
	dialer := *saved
	dialer.NetDialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		var networkDialer net.Dialer
		connection, err := networkDialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return countedRelayConn{Conn: connection, writes: &writes}, nil
	}
	websocket.DefaultDialer = &dialer
	defer func() { websocket.DefaultDialer = saved }()
	sender, receiver, _ := relayPair(t)
	sealer, err := newSealer(testInvitation(), senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	record, err := sealer.seal(kindChunk, bytes.Repeat([]byte{7}, chunkSize))
	if err != nil {
		t.Fatal(err)
	}
	writes.Store(0)
	if err := sender.WriteMessage(websocket.BinaryMessage, record); err != nil {
		t.Fatal(err)
	}
	kind, received, err := receiver.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(received, record) {
		t.Fatalf("relay record changed: %d %v", kind, err)
	}
	if count := writes.Load(); count != 1 {
		t.Fatalf("256 KiB record took %d socket writes, want 1", count)
	}
}
