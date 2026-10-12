package main

import (
	"context"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func BenchmarkDirectPathThroughput(b *testing.B) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	t := &testing.T{}
	sender, receiver, _ := linkedPair(t)
	senderPath, _ := newDirectPath(sender.directRecord, sender.directLost)
	sender.attachDirect(senderPath)
	offer, _ := senderPath.createOffer()
	receiverPath, _ := newDirectPath(receiver.directRecord, receiver.directLost)
	receiver.attachDirect(receiverPath)
	answer, _ := receiverPath.answerOffer(offer, nil)
	_ = senderPath.acceptAnswer(answer)
	<-senderPath.opened
	<-receiverPath.opened
	chunk := make([]byte, chunkSize)
	const total = 256
	b.SetBytes(total * chunkSize)
	b.ResetTimer()
	for range b.N {
		done := make(chan struct{})
		go func() {
			for range total {
				_, _, _ = receiver.next(context.Background(), 10*time.Second)
			}
			close(done)
		}()
		for range total {
			_ = sender.send(kindChunk, chunk)
		}
		<-done
	}
}
