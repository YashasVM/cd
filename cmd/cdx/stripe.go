package main

import (
	"math"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Direct carries the transfer first. Relay probes run only while the direct
// send buffer stays above its low-water mark, and retain at most 1 MiB.
// When direct drains, its writer sends any unacknowledged relay records
// before new data. This bounds merger
// stalls without relying on cumulative ACKs to identify the slower path.
// Records are sealed once; the receiver discards duplicate ciphertext.

// stripeEnabled lets tests and benchmarks keep data on the direct path
// alone (CD_STRIPE=0).
func stripeEnabled() bool {
	return os.Getenv("CD_STRIPE") != "0"
}

const (
	stripeEpochBytes   = 8 * 1024 * 1024
	stripeShareStep    = 1.0 / 64
	stripeStartShare   = 0
	stripeBudget       = 16 * 1024 * 1024
	stripeMaxRelay     = 1024 * 1024
	stripeQueueRecords = 128
)

type stripeItem struct {
	record   []byte
	release  uint64
	backedUp bool
	sentAt   time.Time
}

type striper struct {
	// data holds data records for whichever path is ready first; control
	// holds control records and re-sends, which take the direct path.
	data    chan stripeItem
	control chan []byte
	// relayRoom wakes the relay writer when an ack frees room.
	relayRoom  chan struct{}
	directRoom chan struct{}

	mu       sync.Mutex
	relayCap uint64
	// share is the relay's part of stripeBudget.
	share         float64
	directBlocked bool
	relayDisabled bool
	relayWait     time.Duration
	// epochStart, epochBytes, and lastRate measure each epoch's delivery.
	epochStart time.Time
	epochBytes uint64
	lastRate   float64
	// relayUnacked keeps relay records (to re-send) and relayBytes their
	// size.
	relayUnacked []stripeItem
	relayBytes   uint64
	relayDead    bool
}

func newStriper() *striper {
	s := &striper{
		data: make(chan stripeItem, stripeQueueRecords),
		// A full replay window plus candidates must fit while direct stalls,
		// so the caller remains free to read the error that ends the transfer.
		control:    make(chan []byte, maxPendingRecords),
		relayRoom:  make(chan struct{}, 1),
		directRoom: make(chan struct{}, 1),
	}
	s.setShare(stripeStartShare)
	return s
}

// setShare clamps relay capacity while preserving full direct capacity.
func (s *striper) setShare(share float64) {
	s.share = min(max(share, 0), float64(stripeMaxRelay)/stripeBudget)
	s.relayCap = uint64(s.share * stripeBudget)
	if s.relayCap > 0 {
		records := (s.relayCap + chunkSize - 1) / chunkSize
		s.relayCap += records * (headerBytes + recordTagBytes)
	}
}

// acknowledged drops records the peer confirmed and, once per epoch,
// moves the relay's share.
func (s *striper) acknowledged(bytes uint64, previous uint64, at time.Time) {
	s.mu.Lock()
	covered := 0
	for covered < len(s.relayUnacked) && s.relayUnacked[covered].release <= bytes {
		s.relayBytes -= uint64(len(s.relayUnacked[covered].record))
		covered++
	}
	remaining := copy(s.relayUnacked, s.relayUnacked[covered:])
	clear(s.relayUnacked[remaining:])
	s.relayUnacked = s.relayUnacked[:remaining]
	if !s.relayDead {
		s.adjust(bytes-min(previous, bytes), at)
	}
	s.mu.Unlock()
	select {
	case s.relayRoom <- struct{}{}:
	default:
	}
	select {
	case s.directRoom <- struct{}{}:
	default:
	}
}

// adjust judges epochs with eight ACK cadences of delivered data. Smoothing
// and a five-percent deadband keep ACK bursts from repeatedly moving capacity.
func (s *striper) adjust(delivered uint64, at time.Time) {
	if s.epochStart.IsZero() {
		s.epochStart = at
		return
	}
	s.epochBytes += delivered
	if s.epochBytes < stripeEpochBytes || !at.After(s.epochStart) {
		return
	}
	rate := float64(s.epochBytes) / at.Sub(s.epochStart).Seconds()
	if s.lastRate > 0 {
		rate = 0.75*s.lastRate + 0.25*rate
	}
	if !s.relayDisabled {
		switch {
		case s.lastRate == 0:
			s.setShare(4 * stripeShareStep)
		case rate < s.lastRate*0.95:
			s.setShare(s.share - stripeShareStep)
		case rate > s.lastRate*1.05 && s.directBlocked:
			s.setShare(s.share + stripeShareStep)
		case s.share == 0 && s.directBlocked:
			s.setShare(4 * stripeShareStep)
		}
	}
	s.lastRate = rate
	s.epochStart, s.epochBytes = at, 0
}

// backupRelay runs when direct drains or before control records. Stop
// probing after a backup: cumulative ACKs cannot tell whether the original
// relay copy drained, so continuing could accumulate already-ACKed copies
// in the slow relay's socket buffer.
func (s *striper) backupRelay(force bool) [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !force && len(s.relayUnacked) > 0 && time.Since(s.relayUnacked[0].sentAt) < s.backupDelay() {
		return nil
	}
	var records [][]byte
	for i := range s.relayUnacked {
		item := &s.relayUnacked[i]
		if !item.backedUp {
			records = append(records, item.record)
			item.backedUp = true
		}
	}
	if len(records) > 0 {
		s.relayDisabled = true
		s.setShare(0)
	}
	return records
}

// backupDelay includes the direct bytes ahead of a relay probe. Cumulative
// ACKs cannot cover the probe until those earlier records have arrived.
func (s *striper) backupDelay() time.Duration {
	wait := s.relayWait
	if s.lastRate > 0 {
		wait += time.Duration(float64(directBufferHigh) / s.lastRate * float64(time.Second))
	}
	return wait
}

func (s *striper) backupWake() <-chan time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.relayUnacked) == 0 || s.relayUnacked[0].backedUp {
		return nil
	}
	wait := time.Until(s.relayUnacked[0].sentAt.Add(s.backupDelay()))
	return time.After(max(wait, time.Millisecond))
}

// failRelay stops using the relay and returns its unacknowledged records
// for the direct path; nil if the relay had already failed.
func (s *striper) failRelay() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.relayDead {
		return nil
	}
	s.relayDead = true
	s.setShare(0)
	records := make([][]byte, 0, len(s.relayUnacked))
	for _, item := range s.relayUnacked {
		records = append(records, item.record)
	}
	s.relayUnacked, s.relayBytes = nil, 0
	return records
}

// startStriping hands both paths to writer goroutines. Call with writeMu
// held, when the direct path first opens.
func (link *recordLink) startStriping(path *directPath) {
	stats, ok := path.connection.SCTP().Transport().ICETransport().GetSelectedCandidatePairStats()
	directRTT := time.Duration(stats.CurrentRoundTripTime * float64(time.Second))
	// ACCEPT includes any human consent delay, so this estimate can reject
	// a good relay conservatively. Unmeasured or slower relays use the same
	// synchronous direct writer as CD_STRIPE=0.
	if !ok || link.relayRTT <= 0 || 2*link.relayRTT >= directRTT {
		return
	}
	link.stripe = newStriper()
	link.stripe.relayWait = max(100*time.Millisecond, 2*directRTT+2*link.relayRTT)
	go link.writeDirect(path)
	go link.writeRelay()
}

// sendReleasableStriped queues a sealed record: data records for either
// path, control records (math.MaxUint64 release) for the direct path.
func (link *recordLink) sendReleasableStriped(record []byte, release uint64) error {
	if release == math.MaxUint64 {
		link.enqueueControl(record)
	} else {
		link.enqueueData(record, release)
	}
	return nil
}

func (link *recordLink) enqueueControl(record []byte) {
	select {
	case link.stripe.control <- record:
	case <-link.stop:
	}
}

func (link *recordLink) enqueueData(record []byte, release uint64) {
	select {
	case link.stripe.data <- stripeItem{record: record, release: release}:
	case <-link.stop:
	}
}

// directHasRoom reports whether the data channel's buffer is under the
// direct path's cap.
func (link *recordLink) directHasRoom(path *directPath) bool {
	s := link.stripe
	room := path.channel.BufferedAmount() < directBufferHigh
	blocked := path.channel.BufferedAmount() >= directBufferLow
	s.mu.Lock()
	s.directBlocked = blocked
	s.mu.Unlock()
	if blocked {
		select {
		case s.relayRoom <- struct{}{}:
		default:
		}
	}
	return room
}

func (link *recordLink) writeDirect(path *directPath) {
	s := link.stripe
	idleSince := time.Now()
	for {
		var record []byte
		select {
		case <-link.stop:
			return
		case <-path.lost:
			return // directLost already reported it
		case record = <-s.control:
		default:
			if !link.directHasRoom(path) {
				if time.Since(idleSince) > transferIdle {
					link.deliver(linkItem{err: errDirectStalled, direct: true})
					return
				}
				select {
				case <-link.stop:
					return
				case <-path.lost:
					return
				case record = <-s.control:
					if err := link.sendDirectRecord(path, record); err != nil {
						link.deliver(linkItem{err: err, direct: true})
						return
					}
					idleSince = time.Now()
				case <-path.drained:
				case <-s.directRoom:
				case <-time.After(transferIdle - time.Since(idleSince)):
				}
				continue
			}
			var backupWake <-chan time.Time
			if path.channel.BufferedAmount() <= directBufferLow {
				for _, backup := range s.backupRelay(false) {
					if err := path.send(backup); err != nil {
						link.deliver(linkItem{err: err, direct: true})
						return
					}
				}
				// A stalled direct buffer must wake on drain, not repeatedly arm an
				// expired relay timer while it still cannot send the backup.
				backupWake = s.backupWake()
			}
			select {
			case <-link.stop:
				return
			case <-path.lost:
				return
			case <-path.drained:
				continue
			case <-backupWake:
				continue
			case record = <-s.control:
			case item := <-s.data:
				record = item.record
			}
		}
		idleSince = time.Now()
		if err := link.sendDirectRecord(path, record); err != nil {
			link.deliver(linkItem{err: err, direct: true})
			return
		}
	}
}

// Control records can overtake data in the queues. Back up relay records
// before sending them so END never depends on a final relay ACK.
func (link *recordLink) sendDirectRecord(path *directPath, record []byte) error {
	if messageKind(record[3]) != kindChunk {
		for _, backup := range link.stripe.backupRelay(true) {
			if err := path.send(backup); err != nil {
				return err
			}
		}
	}
	return path.send(record)
}

func (link *recordLink) writeRelay() {
	s := link.stripe
	for {
		s.mu.Lock()
		dead, room := s.relayDead, s.directBlocked && s.relayBytes+chunkSize+headerBytes+recordTagBytes <= s.relayCap
		s.mu.Unlock()
		if dead {
			return
		}
		if !room {
			select {
			case <-link.stop:
				return
			case <-s.relayRoom:
			}
			continue
		}
		var item stripeItem
		select {
		case <-link.stop:
			return
		case item = <-s.data:
		}
		s.mu.Lock()
		if s.relayDead || !s.directBlocked || s.relayBytes+uint64(len(item.record)) > s.relayCap {
			s.mu.Unlock()
			link.enqueueControl(item.record)
			continue
		}
		item.sentAt = time.Now()
		s.relayUnacked = append(s.relayUnacked, item)
		s.relayBytes += uint64(len(item.record))
		s.mu.Unlock()
		err := link.connection.SetWriteDeadline(time.Now().Add(transferIdle))
		if err == nil {
			err = link.connection.WriteMessage(websocket.BinaryMessage, item.record)
		}
		if err != nil {
			link.relayFailed()
			return
		}
	}
}

// relayFailed moves the relay's unacknowledged records to the direct path.
func (link *recordLink) relayFailed() {
	if link.stripe == nil {
		return
	}
	for _, record := range link.stripe.failRelay() {
		link.enqueueControl(record)
	}
}
