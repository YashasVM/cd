package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// recordLink is one side of a paired transfer: it seals and sends records
// on the direct path when that is open (else on the relay WebSocket), and
// returns inbound records from both paths in sequence order. Records carry
// their sequence number in the plaintext header, so records the relay is
// still delivering when the direct path takes over are merged back in order.
type recordLink struct {
	connection *websocket.Conn
	sealer     *recordSealer
	opener     *recordOpener
	// peerLeft is the error for a relay `peer-left` event.
	peerLeft error

	items      chan linkItem
	stop       chan struct{}
	readerDone chan struct{}
	stopOnce   sync.Once
	writeMu    sync.Mutex
	pending    map[uint32][]byte
	expected   uint32

	direct atomic.Pointer[directPath]
	// directUsed is set once a record crossed the direct path in either
	// direction; from then on losing it is fatal and losing the relay is not.
	directUsed atomic.Bool
	// retained holds records sent on the relay while a direct path may
	// still open (guarded by writeMu). When it opens they are sent again on
	// it, so the transfer never waits for a slow relay to drain; the peer
	// drops whichever copy arrives second.
	retained []retainedRecord
	switched bool
}

type retainedRecord struct {
	record []byte
	// release is the acknowledged byte count that makes the record
	// unnecessary (math.MaxUint64: kept until the direct path opens).
	release uint64
}

type linkItem struct {
	record []byte
	err    error
	direct bool
}

// errLinkTimeout reports a read deadline in the net.Error shape callers
// already test with isTimeoutError.
type linkTimeout struct{}

func (linkTimeout) Error() string   { return "timed out waiting for the peer" }
func (linkTimeout) Timeout() bool   { return true }
func (linkTimeout) Temporary() bool { return true }

// maxPendingRecords bounds records held while an earlier one is missing.
const maxPendingRecords = 256

// closeWait bounds how long a finished transfer waits for the peer and the
// relay to acknowledge the close.
const closeWait = 3 * time.Second

// relayPingInterval keeps the relay WebSocket warm while the direct path
// carries the transfer.
const relayPingInterval = 20 * time.Second

func newRecordLink(connection *websocket.Conn, sealer *recordSealer, opener *recordOpener, peerLeft error) *recordLink {
	link := &recordLink{
		connection: connection, sealer: sealer, opener: opener, peerLeft: peerLeft,
		items: make(chan linkItem, 64), stop: make(chan struct{}), readerDone: make(chan struct{}), pending: map[uint32][]byte{},
	}
	return link
}

// start begins reading the relay WebSocket; call it once the caller no
// longer reads the socket itself.
func (link *recordLink) start() {
	go link.readRelay()
	go link.pingRelay()
}

func (link *recordLink) deliver(item linkItem) {
	select {
	case link.items <- item:
	case <-link.stop:
	}
}

func (link *recordLink) readRelay() {
	defer close(link.readerDone)
	for {
		messageType, data, err := link.connection.ReadMessage()
		if err != nil {
			link.deliver(linkItem{err: friendlyRelayError(fmt.Errorf("receive from CD: %w", err))})
			return
		}
		if messageType == websocket.TextMessage {
			var value relayEvent
			if json.Unmarshal(data, &value) == nil {
				switch value.Type {
				case "accepted", "peer-joined":
					continue
				case "peer-left":
					link.deliver(linkItem{err: link.peerLeft})
					return
				}
			}
			link.deliver(linkItem{err: errors.New("CD relay sent unexpected text (transfer aborted)")})
			return
		}
		if messageType != websocket.BinaryMessage {
			link.deliver(linkItem{err: errors.New("CD relay sent an invalid frame")})
			return
		}
		link.deliver(linkItem{record: data})
	}
}

func (link *recordLink) pingRelay() {
	ticker := time.NewTicker(relayPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-link.stop:
			return
		case <-ticker.C:
			_ = link.connection.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second))
		}
	}
}

// attachDirect routes records arriving on path into this link.
func (link *recordLink) attachDirect(path *directPath) {
	link.direct.Store(path)
}

// directRecord and directLost are the callbacks a directPath reports to.
func (link *recordLink) directRecord(record []byte) {
	link.deliver(linkItem{record: record, direct: true})
}

func (link *recordLink) directLost(err error) {
	link.deliver(linkItem{err: fmt.Errorf("%w (direct connection)", err), direct: true})
}

// send seals and writes one record that stays needed until the transfer
// ends (control records, receiver acks).
func (link *recordLink) send(kind messageKind, payload []byte) error {
	return link.sendReleasable(kind, payload, math.MaxUint64)
}

// sendReleasable seals and writes one record; release is the acknowledged
// byte count after which a relay copy need not be re-sent on the direct
// path. Sealing and writing share a lock, so sequence numbers leave in order
// on whichever path carries them.
func (link *recordLink) sendReleasable(kind messageKind, payload []byte, release uint64) error {
	link.writeMu.Lock()
	defer link.writeMu.Unlock()
	record, err := link.sealer.seal(kind, payload)
	if err != nil {
		return err
	}
	path := link.direct.Load()
	if path != nil && path.isOpen() {
		link.directUsed.Store(true)
		if !link.switched {
			link.switched = true
			for _, earlier := range link.retained {
				if err := path.send(earlier.record); err != nil {
					return err
				}
			}
			link.retained = nil
		}
		return path.send(record)
	}
	if path != nil && !link.switched && !path.isLost() {
		link.retained = append(link.retained, retainedRecord{record: record, release: release})
	} else {
		link.retained = nil
	}
	if err := link.connection.SetWriteDeadline(time.Now().Add(transferIdle)); err != nil {
		return err
	}
	return link.connection.WriteMessage(websocket.BinaryMessage, record)
}

// acknowledged drops retained records the peer has confirmed.
func (link *recordLink) acknowledged(bytes uint64) {
	link.writeMu.Lock()
	defer link.writeMu.Unlock()
	kept := link.retained[:0]
	for _, entry := range link.retained {
		if entry.release > bytes {
			kept = append(kept, entry)
		}
	}
	link.retained = kept
}

// next returns the next record in sequence order, waiting up to timeout.
func (link *recordLink) next(ctx context.Context, timeout time.Duration) (messageKind, []byte, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		if kind, plaintext, ok, err := link.ready(); ok || err != nil {
			return kind, plaintext, err
		}
		select {
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		case <-timer.C:
			return 0, nil, linkTimeout{}
		case item := <-link.items:
			if err := link.accept(item); err != nil {
				return 0, nil, err
			}
		}
	}
}

// poll returns the next record if one is already available, without
// waiting; ok is false when none is.
func (link *recordLink) poll() (messageKind, []byte, bool, error) {
	for {
		if kind, plaintext, ok, err := link.ready(); ok || err != nil {
			return kind, plaintext, ok, err
		}
		select {
		case item := <-link.items:
			if err := link.accept(item); err != nil {
				return 0, nil, false, err
			}
		default:
			return 0, nil, false, nil
		}
	}
}

// ready opens the record with the expected sequence number, if held.
func (link *recordLink) ready() (messageKind, []byte, bool, error) {
	record, ok := link.pending[link.expected]
	if !ok {
		return 0, nil, false, nil
	}
	delete(link.pending, link.expected)
	kind, plaintext, err := link.opener.open(record)
	if err != nil {
		return 0, nil, false, err
	}
	link.expected++
	return kind, plaintext, true, nil
}

// accept files one inbound item under its sequence number, or decides
// whether a path failure ends the transfer.
func (link *recordLink) accept(item linkItem) error {
	if item.err != nil {
		if item.direct && !link.directUsed.Load() {
			return nil // an unused direct path failing changes nothing
		}
		if !item.direct && link.directUsed.Load() {
			return nil // the relay is optional once the direct path carries the transfer
		}
		return item.err
	}
	if item.direct {
		link.directUsed.Store(true)
	}
	if len(item.record) < headerBytes {
		return errors.New("the peer sent an invalid record")
	}
	sequence := binary.BigEndian.Uint32(item.record[4:8])
	if sequence < link.expected || link.pending[sequence] != nil {
		// The same record sent on both paths (see retained): keep the first
		// copy. Authentication happens when the kept copy is opened.
		return nil
	}
	if len(link.pending) >= maxPendingRecords {
		return errors.New("the peer sent too many records out of order")
	}
	link.pending[sequence] = item.record
	return nil
}

// close stops the link and the direct path after a failure; the caller's
// deferred Close drops the WebSocket.
func (link *recordLink) close() {
	link.stopOnce.Do(func() { close(link.stop) })
	if path := link.direct.Load(); path != nil {
		path.close()
	}
}

// finish ends a completed transfer without losing its last record. The
// receiver waits for the sender to close the direct path (so COMPLETE sent
// on it is delivered); both sides then do the WebSocket close handshake,
// whose reply arrives only after the relay processed every earlier frame.
func (link *recordLink) finish(waitForPeer bool) {
	link.stopOnce.Do(func() { close(link.stop) })
	deadline := time.Now().Add(closeWait)
	if path := link.direct.Load(); path != nil {
		if waitForPeer && link.directUsed.Load() {
			select {
			case <-path.lost:
			case <-time.After(time.Until(deadline)):
			}
		}
		path.close()
	}
	message := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done")
	if err := link.connection.WriteControl(websocket.CloseMessage, message, deadline); err != nil {
		return
	}
	select {
	case <-link.readerDone:
	case <-time.After(time.Until(deadline) + 100*time.Millisecond):
	}
}
