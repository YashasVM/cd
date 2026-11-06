package main

import "time"

// The relay sender's in-flight window adapts to the path: about two
// bandwidth-delay products (2 × delivery rate × minimum RTT), clamped. A fixed
// 8 MiB window over a 300 ms sender→relay→receiver loop caps throughput near
// 26 MiB/s; a slow link keeps the minimum, so the relay never queues more
// than before. The maximum stays under the relay's 32 MiB per-peer buffer.
const (
	minSendWindow = 8 * 1024 * 1024
	maxSendWindow = 24 * 1024 * 1024
	// rateInterval is the shortest span a delivery-rate sample covers.
	rateInterval = 100 * time.Millisecond
)

type windowSample struct {
	offset uint64
	sentAt time.Time
}

type adaptiveWindow struct {
	size    uint64
	minRTT  time.Duration
	samples []windowSample
	// markBytes and markTime start the current delivery-rate sample.
	markBytes uint64
	markTime  time.Time
}

func newAdaptiveWindow() *adaptiveWindow {
	return &adaptiveWindow{size: minSendWindow}
}

// sent records that bytes up to offset left the sender at time at.
func (window *adaptiveWindow) sent(offset uint64, at time.Time) {
	window.samples = append(window.samples, windowSample{offset: offset, sentAt: at})
}

// acked folds in an acknowledgement covering bytes, received at time at.
func (window *adaptiveWindow) acked(bytes uint64, at time.Time) {
	covered := -1
	for index, sample := range window.samples {
		if sample.offset > bytes {
			break
		}
		covered = index
	}
	if covered >= 0 {
		rtt := at.Sub(window.samples[covered].sentAt)
		if rtt > 0 && (window.minRTT == 0 || rtt < window.minRTT) {
			window.minRTT = rtt
		}
		window.samples = window.samples[covered+1:]
	}
	if window.markTime.IsZero() {
		window.markBytes, window.markTime = bytes, at
		return
	}
	span := at.Sub(window.markTime)
	if span < rateInterval || span < window.minRTT || window.minRTT == 0 {
		return
	}
	rate := float64(bytes-window.markBytes) / span.Seconds()
	target := uint64(2 * rate * window.minRTT.Seconds())
	window.size = min(max(target, minSendWindow), maxSendWindow)
	window.markBytes, window.markTime = bytes, at
}
