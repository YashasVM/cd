package main

import "testing"

func TestSenderProgressAcceptsAcksThenMatchingCompletion(t *testing.T) {
	progress := &senderProgress{sent: 3 << 20, chunks: 12}
	if err := progress.handle(kindAck, encodeCounts(4, 1<<20)); err != nil {
		t.Fatal(err)
	}
	if progress.acknowledged != 1<<20 {
		t.Fatalf("acknowledged = %d", progress.acknowledged)
	}
	progress.ended = true
	// Acks may still arrive after END; completion must match exactly.
	if err := progress.handle(kindAck, encodeCounts(12, 3<<20)); err != nil {
		t.Fatal(err)
	}
	if err := progress.handle(kindComplete, encodeCounts(12, 3<<20)); err != nil || !progress.completed {
		t.Fatalf("completion rejected: %v", err)
	}
	if err := progress.handle(kindAck, encodeCounts(12, 3<<20)); err == nil {
		t.Fatal("accepted a record after completion")
	}
}

func TestSenderProgressRejectsInvalidReceiverRecords(t *testing.T) {
	tests := []struct {
		name    string
		ended   bool
		kind    messageKind
		payload []byte
	}{
		{"ack beyond sent", false, kindAck, encodeCounts(4, 2<<20)},
		{"ack with too many chunks", false, kindAck, encodeCounts(5, 1<<10)},
		{"ack going backwards", false, kindAck, encodeCounts(1, 1)},
		{"short ack", false, kindAck, []byte{1, 2, 3}},
		{"completion before end", false, kindComplete, encodeCounts(4, 1<<20)},
		{"completion with wrong bytes", true, kindComplete, encodeCounts(4, 1<<20-1)},
		{"completion with wrong chunks", true, kindComplete, encodeCounts(3, 1<<20)},
		{"sender kind", false, kindChunk, nil},
	}
	for _, test := range tests {
		progress := &senderProgress{sent: 1 << 20, chunks: 4, acknowledged: 2, ended: test.ended}
		if err := progress.handle(test.kind, test.payload); err == nil {
			t.Fatalf("%s: accepted", test.name)
		}
		if progress.completed {
			t.Fatalf("%s: marked completed", test.name)
		}
	}
}
