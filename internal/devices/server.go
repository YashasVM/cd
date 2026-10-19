package devices

import (
	"crypto/hmac"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Event struct {
	Type     string `json:"type"`
	Protocol string `json:"protocol"`
}
type packet struct {
	kind int
	data []byte
}
type localPeer struct {
	socket *websocket.Conn
	queue  chan packet
	done   chan struct{}
	once   sync.Once
}

func (p *localPeer) close() { p.once.Do(func() { close(p.done); p.socket.Close() }) }
func (p *localPeer) enqueue(value packet) bool {
	select {
	case <-p.done:
		return false
	default:
	}
	select {
	case p.queue <- value:
		return true
	default:
		p.close()
		return false
	}
}
func (p *localPeer) event(kind string) {
	b, _ := json.Marshal(Event{kind, Protocol})
	p.enqueue(packet{websocket.TextMessage, b})
}
func (p *localPeer) writeLoop() {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	defer p.close()
	for {
		select {
		case <-p.done:
			return
		case item := <-p.queue:
			p.socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if p.socket.WriteMessage(item.kind, item.data) != nil {
				return
			}
		case <-ticker.C:
			p.socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if p.socket.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		}
	}
}

// Server forwards opaque authenticated control frames for one known pair.
// Mount it alongside a local file-transfer handler on the same HTTP listener.
type Server struct {
	pair   Pair
	mu     sync.Mutex
	peers  map[string]*localPeer
	closed bool
}

func NewServer(pair Pair) (*Server, error) {
	if err := pair.Validate(); err != nil {
		return nil, err
	}
	return &Server{pair: pair, peers: map[string]*localPeer{}}, nil
}
func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, p := range s.peers {
		p.close()
	}
	return nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws/devices/v1/"+s.pair.PairID {
		http.NotFound(w, r)
		return
	}
	upgrader := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
	socket, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer socket.Close()

	socket.SetReadLimit(2048)
	socket.SetReadDeadline(time.Now().Add(5 * time.Second))
	socket.SetWriteDeadline(time.Now().Add(5 * time.Second))
	nonce, err := randomID(32)
	if err != nil {
		return
	}
	if err = socket.WriteJSON(Challenge{Type: "challenge", Protocol: Protocol, Nonce: nonce}); err != nil {
		return
	}
	kind, data, err := socket.ReadMessage()
	if err != nil || kind != websocket.TextMessage {
		return
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return
	}
	for _, field := range []string{"token", "senderTokenHash", "receiverTokenHash"} {
		if _, present := fields[field]; present {
			return
		}
	}
	var join LocalJoin
	if json.Unmarshal(data, &join) != nil || join.Protocol != Protocol || join.Type != "join" || !validRole(join.Role) {
		return
	}
	expected, err := s.pair.LocalJoin(join.Role, nonce)
	if err != nil {
		return
	}
	supplied, err := decode(join.LocalProof, 32)
	if err != nil {
		return
	}
	required, _ := decode(expected.LocalProof, 32)
	if !hmac.Equal(supplied, required) {
		return
	}
	p := &localPeer{socket: socket, queue: make(chan packet, 16), done: make(chan struct{})}
	other := Sender
	if join.Role == Sender {
		other = Receiver
	}
	s.mu.Lock()
	if s.closed || s.peers[join.Role] != nil {
		s.mu.Unlock()
		socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "role already active"), time.Now().Add(time.Second))
		return
	}
	s.peers[join.Role] = p
	p.event("accepted")
	if peer := s.peers[other]; peer != nil {
		p.event("peer-joined")
		peer.event("peer-joined")
	}
	s.mu.Unlock()
	go p.writeLoop()
	defer func() {
		p.close()
		s.mu.Lock()
		delete(s.peers, join.Role)
		if peer := s.peers[other]; peer != nil {
			peer.event("peer-left")
		}
		s.mu.Unlock()
	}()
	socket.SetReadLimit(MaxFrame)
	socket.SetReadDeadline(time.Now().Add(60 * time.Second))
	socket.SetPongHandler(func(string) error { return socket.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	for {
		kind, data, err = socket.ReadMessage()
		if err != nil {
			return
		}

		if kind == websocket.TextMessage {
			var event Event
			if json.Unmarshal(data, &event) != nil || event.Type != "ping" || event.Protocol != Protocol {
				return
			}
			socket.SetReadDeadline(time.Now().Add(60 * time.Second))
			p.event("pong")
			continue
		}
		if kind != websocket.BinaryMessage || len(data) < 28 {
			return
		}
		socket.SetReadDeadline(time.Now().Add(60 * time.Second))
		s.mu.Lock()
		peer := s.peers[other]
		if peer != nil {
			peer.enqueue(packet{kind, data})
		}
		s.mu.Unlock()
	}
}

var ErrPeerClosed = errors.New("paired-device connection closed")
