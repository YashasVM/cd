package main

import (
	"crypto/hmac"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// localResume accepts the receiver side of the existing authenticated v2
// protocol. Its sessions carry the same records as relay sessions.
type localResume struct {
	invite    invitation
	expiresAt int64
	Sessions  <-chan *resumeSession
	sessions  chan *resumeSession
	stopped   chan struct{}
	mu        sync.Mutex
	active    *websocket.Conn
	nonces    map[string]bool
	closeOnce sync.Once
}

func newLocalResume(invite invitation, expiry int64) *localResume {
	sessions := make(chan *resumeSession, 1)
	return &localResume{invite: invite, expiresAt: expiry, Sessions: sessions, sessions: sessions, stopped: make(chan struct{}), nonces: make(map[string]bool)}
}
func (l *localResume) Close() error {
	l.closeOnce.Do(func() {
		close(l.stopped)
		l.mu.Lock()
		defer l.mu.Unlock()
		if l.active != nil {
			l.active.Close()
		}
	})
	return nil
}
func (l *localResume) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws/v2/"+l.invite.encodedID() {
		http.NotFound(w, r)
		return
	}
	if time.Now().UnixMilli() >= l.expiresAt {
		http.Error(w, "transfer expired", http.StatusGone)
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
	kind, data, err := socket.ReadMessage()
	if err != nil || kind != websocket.TextMessage {
		return
	}
	var join struct {
		Type          string `json:"type"`
		Protocol      string `json:"protocol"`
		Role          string `json:"role"`
		ReceiverToken string `json:"receiverToken"`
		ReceiverNonce string `json:"receiverNonce"`
		NonceProof    string `json:"nonceProof"`
	}
	if json.Unmarshal(data, &join) != nil || join.Type != "join" || join.Protocol != resumeProtocol || join.Role != "receiver" {
		return
	}
	token, err := resumeDecode(join.ReceiverToken, 32)
	if err != nil {
		return
	}
	expected, err := resumeReceiverAdmission(l.invite)
	if err != nil || !hmac.Equal(token, expected) {
		return
	}
	receiverNonce, err := resumeDecode(join.ReceiverNonce, 32)
	if err != nil {
		return
	}
	proof, err := resumeDecode(join.NonceProof, 32)
	if err != nil || !verifyResumeNonceProof(l.invite, "receiver", receiverNonce, proof) {
		return
	}
	l.mu.Lock()
	select {
	case <-l.stopped:
		l.mu.Unlock()
		return
	default:
	}
	if l.active != nil || l.nonces[join.ReceiverNonce] || len(l.nonces) >= 128 || time.Now().UnixMilli() >= l.expiresAt {
		l.mu.Unlock()
		socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "transfer unavailable or nonce reused"), time.Now().Add(time.Second))
		return
	}
	l.active = socket
	l.nonces[join.ReceiverNonce] = true
	l.mu.Unlock()
	defer func() { l.mu.Lock(); l.active = nil; l.mu.Unlock() }()
	senderNonce, err := resumeRandom()
	if err != nil {
		return
	}
	senderProof, err := resumeNonceProof(l.invite, "sender", senderNonce)
	if err != nil {
		return
	}
	sealer, err := newResumeSealer(l.invite, senderNonce, receiverNonce, senderDirection)
	if err != nil {
		return
	}
	opener, err := newResumeOpener(l.invite, senderNonce, receiverNonce, receiverDirection)
	if err != nil {
		return
	}
	socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err = socket.WriteJSON(resumeEvent{Type: "accepted", Protocol: resumeProtocol, ExpiresAt: l.expiresAt}); err != nil {
		return
	}
	if err = socket.WriteJSON(resumeEvent{Type: "peer-joined", Protocol: resumeProtocol, SessionNonce: resumeEncoded(senderNonce), ReceiverNonce: join.ReceiverNonce, SenderNonceProof: resumeEncoded(senderProof), ReceiverNonceProof: join.NonceProof, ExpiresAt: l.expiresAt}); err != nil {
		return
	}
	socket.SetReadLimit(maxRecordBytes)
	socket.SetReadDeadline(time.Now().Add(90 * time.Second))
	session := &resumeSession{socket: socket, seal: sealer, open: opener, senderNonce: resumeEncoded(senderNonce), receiverNonce: join.ReceiverNonce, expiresAt: l.expiresAt, local: true, localDone: make(chan struct{})}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case l.sessions <- session:
	case <-l.stopped:
		return
	case <-r.Context().Done():
		return
	case <-timer.C:
		return
	}
	select {
	case <-session.localDone:
	case <-l.stopped:
	case <-r.Context().Done():
	}
}
