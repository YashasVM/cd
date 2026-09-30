package main

import (
	"testing"
	"time"
)

// simulateLink sends through a bottleneck of bandwidth bytes/s with a fixed
// round-trip delay, acking every 1 MiB like the receiver, and returns the
// window size and the achieved throughput.
func simulateLink(window *adaptiveWindow, bandwidth float64, rtt time.Duration, total uint64) (uint64, float64) {
	const chunk = 256 * 1024
	start := time.Unix(0, 0)
	now := start
	linkFreeAt := start
	type ack struct {
		at    time.Time
		bytes uint64
	}
	var acks []ack
	var sent, acknowledged uint64
	for acknowledged < total {
		for sent < total && sent-acknowledged < window.size {
			sent += chunk
			window.sent(sent, now)
			deliver := linkFreeAt
			if now.After(deliver) {
				deliver = now
			}
			deliver = deliver.Add(time.Duration(float64(chunk) / bandwidth * float64(time.Second)))
			linkFreeAt = deliver
			if sent%(1024*1024) == 0 || sent == total {
				acks = append(acks, ack{at: deliver.Add(rtt), bytes: sent})
			}
		}
		next := acks[0]
		acks = acks[1:]
		now = next.at
		acknowledged = next.bytes
		window.acked(acknowledged, now)
	}
	return window.size, float64(total) / now.Sub(start).Seconds()
}

func TestAdaptiveWindowGrowsOnFastLongPaths(t *testing.T) {
	const mib = 1024 * 1024
	size, throughput := simulateLink(newAdaptiveWindow(), 200*mib, 300*time.Millisecond, 2048*mib)
	if size != maxSendWindow {
		t.Fatalf("window = %d MiB, want the %d MiB cap on a 200 MiB/s, 300 ms path", size/mib, maxSendWindow/mib)
	}
	t.Logf("200 MiB/s link, 300 ms RTT: adaptive window reaches %.1f MiB/s", throughput/mib)
	// A fixed 8 MiB window manages 8 MiB per 300 ms, about 26 MiB/s.
	if throughput < 60*mib {
		t.Fatalf("throughput = %.1f MiB/s, want well above the fixed-window 26 MiB/s", throughput/mib)
	}
}

func TestAdaptiveWindowStaysSmallOnSlowLinks(t *testing.T) {
	const mib = 1024 * 1024
	size, _ := simulateLink(newAdaptiveWindow(), 2*mib, 150*time.Millisecond, 64*mib)
	if size != minSendWindow {
		t.Fatalf("window = %d MiB on a 2 MiB/s link, want the %d MiB minimum", size/mib, minSendWindow/mib)
	}
}

func TestAdaptiveWindowTracksMinimumRTT(t *testing.T) {
	window := newAdaptiveWindow()
	start := time.Unix(0, 0)
	window.sent(1024, start)
	window.sent(2048, start.Add(10*time.Millisecond))
	window.acked(2048, start.Add(90*time.Millisecond))
	if window.minRTT != 80*time.Millisecond || len(window.samples) != 0 {
		t.Fatalf("minRTT = %s with %d samples left", window.minRTT, len(window.samples))
	}
}
