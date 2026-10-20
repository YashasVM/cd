package devices

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Peer is an authenticated socket to either the LAN server or relay. Call Receive
// while using Events; both queues are bounded to prevent unbounded buffering.
type Peer struct {
	socket   *websocket.Conn
	codec    *Codec
	Events   <-chan Event
	events   chan Event
	messages chan Message
	done     chan struct{}
	once     sync.Once
	writeMu  sync.Mutex
	errMu    sync.Mutex
	err      error
}

// Dial connects to the configured relay and uses its admission token protocol.
// Never use Dial with an endpoint learned through untrusted LAN discovery.
func Dial(ctx context.Context, endpoint string, pair Pair, role string, shared ...*Codec) (*Peer, error) {
	return dial(ctx, endpoint, pair, role, false, shared...)
}

// DialLocal connects to a LAN handler with a challenge-bound proof. A spoofed
// discovery endpoint cannot harvest credentials usable at the relay.
func DialLocal(ctx context.Context, endpoint string, pair Pair, role string, shared ...*Codec) (*Peer, error) {
	return dial(ctx, endpoint, pair, role, true, shared...)
}
func dial(ctx context.Context, endpoint string, pair Pair, role string, local bool, shared ...*Codec) (*Peer, error) {
	if err := ValidateEndpoint(endpoint, true); err != nil {
		return nil, err
	}
	if !validRole(role) {
		return nil, errors.New("invalid role")
	}
	var err error
	var codec *Codec
	if len(shared) > 1 {
		return nil, errors.New("at most one codec required")
	}
	if len(shared) == 1 {
		codec = shared[0]
		if codec == nil || codec.pairID != pair.PairID || codec.role != role {
			return nil, errors.New("codec does not match pair and role")
		}
	} else {
		codec, err = NewCodec(pair, role)
		if err != nil {
			return nil, err
		}
	}
	socket, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			socket.Close()
		}
	}()

	socket.SetReadLimit(2048)
	socket.SetReadDeadline(time.Now().Add(10 * time.Second))
	socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	handshakeDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			socket.Close()
		case <-handshakeDone:
		}
	}()
	defer close(handshakeDone)
	if local {
		kind, data, err := socket.ReadMessage()
		if err != nil {
			return nil, err
		}
		var challenge Challenge
		if kind != websocket.TextMessage || json.Unmarshal(data, &challenge) != nil || challenge.Type != "challenge" || challenge.Protocol != Protocol {
			return nil, errors.New("invalid local challenge")
		}
		join, err := pair.LocalJoin(role, challenge.Nonce)
		if err != nil {
			return nil, err
		}
		if err = socket.WriteJSON(join); err != nil {
			return nil, err
		}
	} else {
		join, err := pair.Join(role)
		if err != nil {
			return nil, err
		}
		if err = socket.WriteJSON(join); err != nil {
			return nil, err
		}
	}
	kind, data, err := socket.ReadMessage()
	if err != nil {
		return nil, err
	}
	var accepted Event
	if kind != websocket.TextMessage || json.Unmarshal(data, &accepted) != nil || accepted.Type != "accepted" || accepted.Protocol != Protocol {
		return nil, errors.New("device join not accepted")
	}
	socket.SetReadLimit(MaxFrame)
	events := make(chan Event, 16)
	p := &Peer{socket: socket, codec: codec, events: events, Events: events, messages: make(chan Message, 16), done: make(chan struct{})}
	events <- accepted
	socket.SetReadDeadline(time.Now().Add(60 * time.Second))
	socket.SetPongHandler(func(string) error { return socket.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	success = true
	go p.readLoop()
	go p.heartbeat(ctx)
	return p, nil
}
func (p *Peer) fail(err error) {
	p.once.Do(func() { p.errMu.Lock(); p.err = err; p.errMu.Unlock(); close(p.done); p.socket.Close() })
}

// Alive reports whether this local connection has observed a disconnect.
func (p *Peer) Alive() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}
func (p *Peer) Close() error   { p.fail(ErrPeerClosed); return nil }
func (p *Peer) failure() error { p.errMu.Lock(); defer p.errMu.Unlock(); return p.err }
func (p *Peer) Send(message Message) error {
	frame, err := p.codec.Seal(message)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	select {
	case <-p.done:
		return p.failure()
	default:
	}
	p.socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err = p.socket.WriteMessage(websocket.BinaryMessage, frame)
	if err != nil {
		p.fail(err)
	}
	return err
}
func (p *Peer) Receive(ctx context.Context) (Message, error) {
	select {
	case m := <-p.messages:
		return m, nil
	case <-p.done:
		return Message{}, p.failure()
	case <-ctx.Done():
		return Message{}, ctx.Err()
	}
}
func (p *Peer) readLoop() {
	defer close(p.events)
	for {
		kind, data, err := p.socket.ReadMessage()
		if err != nil {
			p.fail(err)
			return
		}
		switch kind {
		case websocket.TextMessage:
			var event Event
			if json.Unmarshal(data, &event) != nil || event.Protocol != Protocol || (event.Type != "peer-joined" && event.Type != "peer-left" && event.Type != "pong") {
				p.fail(errors.New("invalid device event"))
				return
			}
			p.socket.SetReadDeadline(time.Now().Add(60 * time.Second))
			if event.Type == "pong" {
				continue
			}
			select {
			case p.events <- event:
			default:
				p.fail(errors.New("device event queue full"))
				return
			}
		case websocket.BinaryMessage:
			m, err := p.codec.Open(data)
			if err != nil {
				p.fail(err)
				return
			}
			p.socket.SetReadDeadline(time.Now().Add(60 * time.Second))
			select {
			case p.messages <- m:
			default:
				p.fail(errors.New("device message queue full"))
				return
			}
		default:
			p.fail(errors.New("invalid device frame"))
			return
		}
	}
}
func (p *Peer) heartbeat(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			p.fail(ctx.Err())
			return
		case <-p.done:
			return
		case <-ticker.C:
			p.writeMu.Lock()
			deadline := time.Now().Add(10 * time.Second)
			p.socket.SetWriteDeadline(deadline)
			err := p.socket.WriteControl(websocket.PingMessage, nil, deadline)
			if err == nil {
				err = p.socket.WriteJSON(Event{Type: "ping", Protocol: Protocol})
			}
			p.writeMu.Unlock()
			if err != nil {
				p.fail(err)
				return
			}
		}
	}
}
