package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestReverseLANBlockedSetupStartsRelayData(t *testing.T) {
	loopbackLane(t)
	t.Setenv("CD_LAN_GRACE", "1")
	sender, receiver, _ := linkedPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan time.Time, 1)
	sender.reverseLAN = func(*lanOffer) <-chan struct{} {
		started <- time.Now()
		return make(chan struct{})
	}
	data := bytes.Repeat([]byte{0x37}, 8*1024*1024)
	done := make(chan error, 1)
	go func() {
		done <- transfer(ctx, sender, bytes.NewReader(data), readyOutput{Filename: "blocked.bin", Size: uint64(len(data))}, nil, sendHooks{})
	}()
	kind, _, err := receiver.next(ctx, time.Second)
	if err != nil || kind != kindOffer {
		t.Fatalf("receive offer: kind=%d err=%v", kind, err)
	}
	acceptance, _ := json.Marshal(chunkAcceptance{ChunkSize: chunkSize, LAN: reverseTestOffer().LAN})
	if err := receiver.send(kindAccept, acceptance); err != nil {
		t.Fatal(err)
	}
	setupStarted := <-started
	kind, payload, err := receiver.next(ctx, time.Second)
	if err != nil || kind != kindChunk || !bytes.Equal(payload, data[:chunkSize]) {
		t.Fatalf("blocked reverse setup did not relay first data: kind=%d err=%v", kind, err)
	}
	if elapsed := time.Since(setupStarted); elapsed < reverseLANGrace || elapsed > 250*time.Millisecond {
		t.Fatalf("first relay data arrived after %v, want 50ms setup timer", elapsed)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled transfer did not stop")
	}
}

func TestReverseLANGraceBoundsBlockedSetup(t *testing.T) {
	t.Setenv("CD_LAN_GRACE", "1")
	started := time.Now()
	if err := waitReverseLAN(context.Background(), 8*1024*1024, make(chan struct{})); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed < reverseLANGrace || elapsed > 250*time.Millisecond {
		t.Fatalf("blocked setup grace took %v, want a 50ms timer", elapsed)
	}
}

func TestReverseLANGraceEndsWhenSetupCompletes(t *testing.T) {
	t.Setenv("CD_LAN_GRACE", "1")
	done := make(chan struct{})
	close(done)
	started := time.Now()
	if err := waitReverseLAN(context.Background(), 8*1024*1024, done); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) >= reverseLANGrace {
		t.Fatal("completed setup waited for grace timer")
	}
}

func TestReverseLANGraceCancellationIsPrompt(t *testing.T) {
	t.Setenv("CD_LAN_GRACE", "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- waitReverseLAN(ctx, 8*1024*1024, make(chan struct{})) }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation returned %v", err)
		}
	case <-time.After(25 * time.Millisecond):
		t.Fatal("cancellation waited for setup grace")
	}
}

func TestReverseLANGraceSkipsLegacyRelaySmallAndDisabled(t *testing.T) {
	for _, test := range []struct {
		name string
		size uint64
		done <-chan struct{}
		env  string
	}{
		{name: "legacy or relay", size: 8 * 1024 * 1024, env: "1"},
		{name: "small", size: 8*1024*1024 - 1, done: make(chan struct{}), env: "1"},
		{name: "disabled", size: 8 * 1024 * 1024, done: make(chan struct{}), env: "0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("CD_LAN_GRACE", test.env)
			started := time.Now()
			if err := waitReverseLAN(context.Background(), test.size, test.done); err != nil {
				t.Fatal(err)
			}
			if time.Since(started) >= reverseLANGrace {
				t.Fatal("transfer unnecessarily waited for setup")
			}
		})
	}
}
