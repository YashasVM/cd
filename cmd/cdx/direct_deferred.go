package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/pion/webrtc/v4"
)

const deferredDirectOfferMode = "deferred-v1"

// The relay hint only tells a receiver that its sender can understand this
// hello. The sender opts in only after decrypting/authenticating the hello.
// Its empty candidate is harmless to v1 senders that already support kindSignal:
// until an SDP answer they ignore candidate-only signaling.
func advertiseDeferredDirect(link *recordLink) error {
	payload, err := json.Marshal(directSignal{Candidate: &webrtc.ICECandidateInit{}, DeferredOffer: true})
	if err != nil {
		return err
	}
	return link.send(kindSignal, payload)
}

func isDeferredDirectHello(payload []byte) bool {
	if len(payload) > 1024 {
		return false
	}
	var signal directSignal
	return json.Unmarshal(payload, &signal) == nil && signal.DeferredOffer && signal.SDP == "" && signal.Candidate != nil && signal.Candidate.Candidate == ""
}

type deferredDirectOffer struct {
	pending <-chan string
}

// Race the existing bounded full ICE gathering against an authenticated modern
// receiver's hello. Legacy receivers send no hello and retain the old complete
// SDP file offer, including public candidates. Modern receivers can begin LAN
// or relay data immediately and receive the same full SDP later.
func prepareDirectOffer(ctx context.Context, link *recordLink, offers <-chan string) (*deferredDirectOffer, string, error) {
	state := &deferredDirectOffer{}
	if offers == nil {
		return state, "", nil
	}
	for {
		if kind, payload, ok, err := link.poll(); err != nil {
			return nil, "", err
		} else if ok {
			if kind != kindSignal || !isDeferredDirectHello(payload) {
				return nil, "", NewFailure(failureProtocol, "receiver sent invalid pre-offer signaling", retryNever)
			}
			link.sealer.allowDirectSignal = true
			state.pending = offers
			return state, "", nil
		}
		select {
		case <-ctx.Done():
			return nil, "", ctx.Err()
		case <-link.stop:
			return nil, "", NewFailure(failureDisconnected, "transfer closed while preparing direct offer", retryNewTransfer)
		case sdp := <-offers:
			return state, sdp, nil
		case item := <-link.items:
			if err := link.accept(item); err != nil {
				return nil, "", err
			}
		}
	}
}

func (state *deferredDirectOffer) send(link *recordLink, sdp string) error {
	state.pending = nil
	if sdp == "" {
		return nil
	}
	// A successful local TCP path may already have retired the waiting ICE
	// connection. It needs no offer, and stale SDP must never replace it.
	path := link.direct.Load()
	if path == nil || path.connection == nil || path.isLost() {
		return nil
	}
	if current := path.connection.LocalDescription(); current != nil {
		sdp = current.SDP
	}
	if len(sdp) > maxSDPBytes {
		return NewFailure(failureProtocol, "direct offer is too large", retryNever)
	}
	payload, err := json.Marshal(directSignal{SDP: sdp})
	if err != nil {
		return err
	}
	return link.send(kindSignal, payload)
}

func (state *deferredDirectOffer) flush(link *recordLink) error {
	if state.pending == nil {
		return nil
	}
	select {
	case sdp := <-state.pending:
		return state.send(link, sdp)
	default:
		return nil
	}
}

// next has one record consumer and one fixed timeout. SDP readiness wakes a
// sender even if a congested relay has not delivered another ACK yet. No detached
// signaling writer can race completion or emit control after END.
func (state *deferredDirectOffer) next(ctx context.Context, link *recordLink, timeout time.Duration) (messageKind, []byte, error) {
	if state.pending == nil {
		return link.next(ctx, timeout)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		if err := state.flush(link); err != nil {
			return 0, nil, err
		}
		if kind, payload, ok, err := link.poll(); ok || err != nil {
			return kind, payload, err
		}
		select {
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		case <-link.stop:
			return 0, nil, NewFailure(failureDisconnected, "transfer closed while negotiating direct path", retryNewTransfer)
		case <-timer.C:
			return 0, nil, linkTimeout{}
		case sdp := <-state.pending:
			if err := state.send(link, sdp); err != nil {
				return 0, nil, err
			}
		case item := <-link.items:
			if err := link.accept(item); err != nil {
				return 0, nil, err
			}
		}
	}
}

func receiveDeferredDirect(link *recordLink, payload []byte) error {
	if len(payload) > 2*maxSDPBytes {
		return NewFailure(failureProtocol, "direct offer is too large", retryNever)
	}
	var signal directSignal
	if json.Unmarshal(payload, &signal) != nil || signal.SDP == "" || len(signal.SDP) > maxSDPBytes || signal.Candidate != nil || signal.DeferredOffer {
		return NewFailure(failureProtocol, "the sender sent an invalid deferred direct offer", retryNever)
	}
	if directEnabled() && link.direct.Load() == nil {
		go answerDirectPath(link, signal.SDP)
	}
	return nil
}
