package main

import (
	"context"
	"encoding/json"
	"github.com/pion/webrtc/v4"
	"sync"
	"sync/atomic"
)

// Only CHUNK records use the direct channel. The caller drains every outstanding
// durable relay ACK before switching, so a receiver keeps one strict sequence.
type resumeDirect struct {
	path       *directPath
	session    *resumeSession
	used       atomic.Bool
	closing    atomic.Bool
	closeOnce  sync.Once
	answered   bool
	candidates int
	pending    []webrtc.ICECandidateInit
}

func newResumeDirect(ctx context.Context, session *resumeSession, size uint64) (*resumeDirect, *directOffer) {
	if session.local || !directEnabled() || size < directMinBytes {
		return nil, nil
	}
	direct := &resumeDirect{session: session}
	path, err := newDirectPath(func([]byte) { direct.failed() }, func(error) { direct.failed() })
	if err != nil {
		return nil, nil
	}
	direct.path = path
	path.assembler.version = resumeVersion
	sdp, err := path.createOffer()
	if err != nil || len(sdp) == 0 || len(sdp) > maxSDPBytes {
		direct.close()
		return nil, nil
	}
	stop := context.AfterFunc(ctx, direct.close)
	go func() { <-path.lost; stop() }()
	return direct, &directOffer{SDP: sdp}
}
func (d *resumeDirect) failed() {
	if d.used.Load() && !d.closing.Load() {
		d.session.socket.Close()
	}
}
func (d *resumeDirect) close() {
	if d != nil {
		d.closeOnce.Do(func() { d.closing.Store(true); d.path.close() })
	}
}
func (d *resumeDirect) ready() bool { return d != nil && !d.closing.Load() && d.path.isOpen() }
func (d *resumeDirect) signal(payload []byte) {
	if d == nil || d.closing.Load() {
		return
	}
	var signal directSignal
	if len(payload) > maxSDPBytes+4096 || json.Unmarshal(payload, &signal) != nil {
		d.negotiationFailed()
		return
	}
	if signal.Candidate != nil {
		d.candidates++
		if d.candidates > maxRemoteCandidates {
			d.negotiationFailed()
			return
		}
		if !d.answered {
			d.pending = append(d.pending, *signal.Candidate)
			return
		}
		if err := d.path.addCandidate(*signal.Candidate); err != nil {
			d.negotiationFailed()
		}
		return
	}
	if d.answered || len(signal.SDP) == 0 || len(signal.SDP) > maxSDPBytes {
		d.negotiationFailed()
		return
	}
	if err := d.path.acceptAnswer(signal.SDP); err != nil {
		d.negotiationFailed()
		return
	}
	d.answered = true
	for _, candidate := range d.pending {
		if err := d.path.addCandidate(candidate); err != nil {
			d.negotiationFailed()
			return
		}
	}
	d.pending = nil
}
func (d *resumeDirect) sendChunk(payload []byte) error {
	if d.path.isLost() {
		return NewFailure(failureDisconnected, "direct connection interrupted; resume with fresh session", retrySameRequest)
	}
	record, err := d.session.seal.seal(kindChunk, payload)
	if err != nil {
		return err
	}
	if err = d.path.send(record); err != nil {
		return NewFailure(failureDisconnected, "direct connection interrupted; retained progress is available", retrySameRequest, err)
	}
	return nil
}
func nextResumeControl(session *resumeSession, direct *resumeDirect) (messageKind, []byte, error) {
	for {
		kind, data, err := session.next()
		if err != nil {
			return 0, nil, err
		}
		if kind == kindSignal {
			direct.signal(data)
			continue
		}
		return kind, data, nil
	}
}

func (d *resumeDirect) negotiationFailed() {
	if d.used.Load() {
		d.session.socket.Close()
	}
	d.close()
}
