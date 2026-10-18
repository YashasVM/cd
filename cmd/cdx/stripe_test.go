package main

import (
	"bytes"
	"context"
	"fmt"
	"github.com/pion/webrtc/v4"
	"reflect"
	"testing"
	"time"
)

func TestStriperStartsDirectOnly(t *testing.T) {
	s := newStriper()
	if s.relayCap != 0 {
		t.Fatalf("initial relay cap = %d, want zero", s.relayCap)
	}
	s.setShare(0)
	if s.relayCap != 0 {
		t.Fatal("zero share still assigns relay records")
	}
}

func TestStriperAcknowledgedPrunesRelayRecords(t *testing.T) {
	s := newStriper()
	s.relayUnacked = []stripeItem{
		{record: make([]byte, 100), release: 100},
		{record: make([]byte, 100), release: 200},
		{record: make([]byte, 100), release: 300},
	}
	s.relayBytes = 300

	s.acknowledged(200, 0, time.Unix(0, 0))

	if len(s.relayUnacked) != 1 || s.relayUnacked[0].release != 300 {
		t.Fatalf("relayUnacked releases = %v, want [300]", releasesOf(s.relayUnacked))
	}
	if s.relayBytes != 100 {
		t.Fatalf("relayBytes = %d, want 100", s.relayBytes)
	}
}

func TestStriperAdjustNeedsDeliveredBytes(t *testing.T) {
	s := newStriper()
	at := time.Unix(1, 0)
	s.adjust(0, at)
	for i := range 10 {
		s.adjust(0, at.Add(time.Duration(i+1)*time.Second))
	}
	if s.share != 0 {
		t.Fatalf("idle samples enabled relay: %v", s.share)
	}
}

func TestStriperFailRelayReturnsUnacknowledgedInOrder(t *testing.T) {
	s := newStriper()
	s.setShare(1)
	s.relayUnacked = []stripeItem{
		{record: []byte("a"), release: 10},
		{record: []byte("bb"), release: 20},
		{record: []byte("ccc"), release: 30},
	}
	s.relayBytes = 6

	got := s.failRelay()

	want := [][]byte{[]byte("a"), []byte("bb"), []byte("ccc")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("failRelay() = %q, want %q", got, want)
	}
	if !s.relayDead {
		t.Fatal("relayDead = false after failRelay")
	}
	if again := s.failRelay(); again != nil {
		t.Fatalf("second failRelay() = %q, want nil", again)
	}
}

func TestStriperAcknowledgedAfterRelayFailureKeepsShare(t *testing.T) {
	const mib = 1 << 20
	s := newStriper()
	s.failRelay()
	t0 := time.Unix(0, 0)

	s.acknowledged(1*mib, 0, t0)
	s.acknowledged(2*mib, 1*mib, t0.Add(200*time.Millisecond))
	s.acknowledged(4*mib, 2*mib, t0.Add(400*time.Millisecond))

	if s.share != stripeStartShare {
		t.Fatalf("share after relay failure = %v, want unchanged %v", s.share, stripeStartShare)
	}
}

func TestStriperAcknowledgedSignalsRoomWithoutBlocking(t *testing.T) {
	s := newStriper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		t0 := time.Unix(0, 0)
		for i := range 5 {
			s.acknowledged(uint64(i+1)<<20, uint64(i)<<20, t0.Add(time.Duration(i)*time.Second))
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("acknowledged blocked on relayRoom")
	}
	if n := len(s.relayRoom); n != 1 {
		t.Fatalf("relayRoom holds %d signals, want 1 pending", n)
	}
}

func releasesOf(items []stripeItem) []uint64 {
	var out []uint64
	for _, item := range items {
		out = append(out, item.release)
	}
	return out
}

func TestStripedTransferSurvivesRelayLoss(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	t.Cleanup(func() { directICEServers = saved })
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
		case <-time.After(10 * time.Second):
			t.Fatal("local direct path did not open")
		}
	}
	// Admit the relay for this failure-path fixture; policy admission is
	// measured separately with real OFFER/ACCEPT and ICE round trips.
	sender.relayRTT = time.Nanosecond
	sender.striping = true
	if err := sender.send(kindOffer, []byte("ready")); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := receiver.next(context.Background(), 5*time.Second); err != nil || kind != kindOffer {
		t.Fatalf("direct setup = %v %v", kind, err)
	}
	if sender.stripe == nil {
		t.Fatal("failure fixture did not start striped writers")
	}
	sender.stripe.mu.Lock()
	sender.stripe.setShare(1)
	sender.stripe.mu.Unlock()
	received := make(chan error, 1)
	go func() {
		for index := range 32 {
			kind, payload, err := receiver.next(context.Background(), 5*time.Second)
			if err != nil {
				received <- err
				return
			}
			if kind != kindChunk || !bytes.Equal(payload, bytes.Repeat([]byte{byte(index)}, chunkSize)) {
				received <- fmt.Errorf("record %d differs", index)
				return
			}
			if index == 15 {
				_ = sender.connection.Close()
			}
		}
		received <- nil
	}()
	for index := range 32 {
		if err := sender.sendReleasable(kindChunk, bytes.Repeat([]byte{byte(index)}, chunkSize), uint64(index+1)*chunkSize); err != nil {
			t.Fatal(err)
		}
		// Poll to observe a relay failure and schedule its held records again.
		if _, _, _, err := sender.poll(); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case err := <-received:
			if err != nil {
				t.Fatal(err)
			}
			return
		case <-deadline:
			t.Fatal("striped transfer stalled after relay loss")
		default:
			if _, _, _, err := sender.poll(); err != nil {
				t.Fatal(err)
			}
			time.Sleep(time.Millisecond)
		}
	}
}

func TestStriperDeadbandAndBackup(t *testing.T) {
	s := newStriper()
	at := time.Unix(1, 0)
	s.adjust(0, at)
	s.adjust(stripeEpochBytes, at.Add(time.Second))
	initial := s.relayCap
	s.directBlocked = true
	s.adjust(stripeEpochBytes, at.Add(2*time.Second))
	if s.relayCap != initial {
		t.Fatalf("flat rate changed cap: %d -> %d", initial, s.relayCap)
	}
	s.adjust(stripeEpochBytes, at.Add(2500*time.Millisecond))
	if s.relayCap != initial {
		t.Fatal("faster delivery exceeded the relay bound")
	}
	s.relayUnacked = []stripeItem{{record: []byte("ciphertext"), release: 100}}
	if got := s.backupRelay(true); len(got) != 1 || string(got[0]) != "ciphertext" {
		t.Fatalf("backup = %q", got)
	}
	if len(s.backupRelay(true)) != 0 {
		t.Fatal("backed up twice")
	}
	if !s.relayDisabled || s.relayCap != 0 {
		t.Fatal("slow probe still enabled")
	}
	s.adjust(stripeEpochBytes, at.Add(3*time.Second))
	s.adjust(stripeEpochBytes, at.Add(7*time.Second))
	if s.relayCap != 0 {
		t.Fatal("disabled probe restarted")
	}
}

func TestStriperRateBackoffCanProbeAgain(t *testing.T) {
	s := newStriper()
	s.directBlocked = true
	at := time.Unix(1, 0)
	s.adjust(0, at)
	s.adjust(stripeEpochBytes, at.Add(time.Second))
	initial := s.relayCap
	for i := 1; i <= 4; i++ {
		s.adjust(stripeEpochBytes, at.Add(time.Second+time.Duration(i)*4*time.Second))
	}
	if s.relayCap >= initial || s.relayDisabled {
		t.Fatal("rate dip did not back off safely")
	}
	for i := 5; i <= 20; i++ {
		s.adjust(stripeEpochBytes, at.Add(time.Second+time.Duration(i)*4*time.Second))
	}
	if s.relayCap == 0 || s.relayDisabled {
		t.Fatal("stable baseline did not permit another bounded probe")
	}
}

func TestStriperBackupDeadlineAndControl(t *testing.T) {
	s := newStriper()
	s.relayWait = time.Second
	s.relayUnacked = []stripeItem{{record: []byte("pending"), release: 1, sentAt: time.Now()}}
	if len(s.backupRelay(false)) != 0 || s.relayDisabled {
		t.Fatal("backed up a fresh fast-relay probe")
	}
	if got := s.backupRelay(true); len(got) != 1 {
		t.Fatal("control did not force a backup")
	}
	if s.backupWake() != nil {
		t.Fatal("backed-up records scheduled another timer")
	}
	s = newStriper()
	s.relayWait = time.Millisecond
	s.relayUnacked = []stripeItem{{record: []byte("late"), sentAt: time.Now().Add(-time.Second)}}
	select {
	case <-s.backupWake():
	case <-time.After(time.Second):
		t.Fatal("late relay record did not wake direct")
	}
	if got := s.backupRelay(false); len(got) != 1 || !s.relayDisabled {
		t.Fatal("late relay probe was not backed up and disabled")
	}
}

func TestStriperControlQueueFitsReplayAndCandidates(t *testing.T) {
	link := &recordLink{stripe: newStriper(), stop: make(chan struct{})}
	defer close(link.stop)
	done := make(chan struct{})
	go func() {
		defer close(done)
		// The main loop must remain free to read an error if direct stalls while
		// replaying a full window and sending the bounded candidate set.
		for range maxSendWindow/chunkSize + maxRemoteCandidates + 8 {
			link.enqueueControl([]byte("control"))
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("control queue blocked the error-reading transfer loop")
	}
}
