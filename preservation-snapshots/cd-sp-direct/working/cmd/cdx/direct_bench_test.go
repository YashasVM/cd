package main

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func BenchmarkDirectPathThroughput(b *testing.B) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	sender, receiver, _ := linkedPair(b)
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
	benchmarkRecordTransfer(b, sender, receiver)
}

func BenchmarkRelayPathThroughput(b *testing.B) {
	sender, receiver, _ := linkedPair(b)
	benchmarkRecordTransfer(b, sender, receiver)
}

func benchmarkRecordTransfer(b *testing.B, sender, receiver *recordLink) {
	b.Helper()
	chunk := make([]byte, chunkSize)
	for index := range chunk {
		chunk[index] = byte(index*31 + index/251)
	}
	const total = 256
	b.SetBytes(total * chunkSize)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		done := make(chan error, 1)
		go func() {
			for index := range total {
				kind, payload, err := receiver.next(context.Background(), 10*time.Second)
				if err != nil {
					done <- err
					return
				}
				if kind != kindChunk || !bytes.Equal(payload, chunk) {
					done <- fmt.Errorf("record %d: kind %d or payload differs", index, kind)
					return
				}
			}
			done <- nil
		}()
		for range total {
			if err := sender.send(kindChunk, chunk); err != nil {
				b.Fatal(err)
			}
		}
		if err := <-done; err != nil {
			b.Fatal(err)
		}
	}
}
