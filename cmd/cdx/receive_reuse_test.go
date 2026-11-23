package main

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func pooledRelayReceiver(t *testing.T, pooled bool) (*recordLink, *websocket.Conn, *recordSealer) {
	t.Helper()
	client, peer := relayReadSockets(t, 4096)
	opener, _ := newOpener(testInvitation(), senderDirection)
	sealer, _ := newSealer(testInvitation(), receiverDirection)
	link := newRecordLink(client, sealer, opener, errors.New("sender left"))
	if pooled {
		link.enableReceiveReuse()
	}
	link.start()
	t.Cleanup(link.close)
	source, _ := newSealer(testInvitation(), senderDirection)
	return link, peer, source
}

func TestReceiveReuseRequiresExplicitReleaseAndPreservesQueuedRecords(t *testing.T) {
	link, peer, source := pooledRelayReceiver(t, true)
	read := func(value byte) []byte {
		t.Helper()
		kind, plaintext, err := link.next(context.Background(), time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(plaintext, bytes.Repeat([]byte{value}, 128*1024)) {
			t.Fatalf("corrupted record %d: kind=%d error=%v", value, kind, err)
		}
		return plaintext
	}
	wire := func(value byte) []byte {
		t.Helper()
		record, err := source.sealInto(nil, kindChunk, bytes.Repeat([]byte{value}, 128*1024))
		if err != nil {
			t.Fatal(err)
		}
		return record
	}
	send := func(record []byte) {
		t.Helper()
		if err := peer.WriteMessage(websocket.BinaryMessage, record); err != nil {
			t.Fatal(err)
		}
	}
	send(wire(1))
	first := read(1)
	send(wire(2))
	read(2) // Omitting release must preserve the earlier caller's payload.
	if !bytes.Equal(first, bytes.Repeat([]byte{1}, 128*1024)) {
		t.Fatal("an unreleased plaintext was overwritten")
	}
	secondStorage := &link.consumedRecord[0]
	link.releaseInbound()
	link.releaseInbound() // Repeated releases must not enqueue duplicate aliases.
	send(wire(3))
	read(3)
	if &link.consumedRecord[0] != secondStorage {
		t.Fatal("explicitly released storage was not reused")
	}
	link.releaseInbound()
	older, newer, final := wire(4), wire(5), wire(6)
	send(newer)
	send(older)
	read(4)
	queued := link.pending[4]
	if len(queued) == 0 || &queued[0] == &link.consumedRecord[0] {
		t.Fatal("queued record shares storage with the released record")
	}
	link.releaseInbound()
	send(final)
	read(5)
	link.releaseInbound()
	read(6)
	link.releaseInbound()
	if !bytes.Equal(first, bytes.Repeat([]byte{1}, 128*1024)) {
		t.Fatal("an omitted release did not preserve original payload ownership")
	}
	corrupt := wire(7)
	corrupt[len(corrupt)-1] ^= 1
	send(corrupt)
	if _, plaintext, err := link.next(context.Background(), time.Second); err == nil || plaintext != nil || link.consumedRecord != nil {
		t.Fatal("authentication failure returned or recycled an unverified plaintext")
	}
}

func TestReceiveReuseCancellationAndDefaultOwnership(t *testing.T) {
	for _, pooled := range []bool{false, true} {
		link, peer, source := pooledRelayReceiver(t, pooled)
		record, _ := source.sealInto(nil, kindChunk, []byte("owned until released"))
		if err := peer.WriteMessage(websocket.BinaryMessage, record); err != nil {
			t.Fatal(err)
		}
		_, plaintext, err := link.next(context.Background(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, _, err := link.next(ctx, time.Second); !errors.Is(err, context.Canceled) {
			t.Fatal("cancellation was ignored")
		}
		if !bytes.Equal(plaintext, []byte("owned until released")) || len(link.receivePool) != 0 {
			t.Fatal("canceled read recycled caller-owned storage")
		}
		link.releaseInbound()
		if pooled && len(link.receivePool) != 1 || !pooled && link.receivePool != nil {
			t.Fatal("pooling changed default ownership or failed to release opted-in storage")
		}
	}
}

func TestReceiveReusePoolHasHardByteBound(t *testing.T) {
	link := &recordLink{}
	link.enableReceiveReuse()
	for range 2 * maxRecycledRecords {
		link.consumedRecord = make([]byte, maxRecordBytes)
		link.releaseInbound()
	}
	if len(link.receivePool) != maxRecycledRecords {
		t.Fatal("recycled record count is not bounded")
	}
	var total int
	for len(link.receivePool) > 0 {
		total += cap(<-link.receivePool)
	}
	if total != maxRecycledRecords*maxRecordBytes {
		t.Fatal("recycled storage exceeded the byte bound")
	}
	link.consumedRecord = make([]byte, 1, maxRecordBytes+1)
	link.releaseInbound()
	if len(link.receivePool) != 0 {
		t.Fatal("oversized backing storage entered the pool")
	}
}

func TestReceiveReuseDoesNotRetainUnreusableDirectStorage(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	opener, _ := newOpener(testInvitation(), senderDirection)
	record, _ := sealer.sealInto(nil, kindChunk, []byte("direct"))
	link := &recordLink{opener: opener, pending: make(map[uint32][]byte), items: make(chan linkItem, 1)}
	link.enableReceiveReuse()
	link.items <- linkItem{record: record, direct: true}
	if _, _, err := link.next(context.Background(), time.Second); err != nil {
		t.Fatal(err)
	}
	link.releaseInbound()
	if len(link.receivePool) != 0 || len(link.reusable) != 0 {
		t.Fatal("direct storage entered a pool only the relay reader can reuse")
	}
}
