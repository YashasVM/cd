package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type localReceiverJoin struct {
	Type          string `json:"type"`
	Protocol      string `json:"protocol"`
	Role          string `json:"role"`
	ReceiverToken string `json:"receiverToken"`
	ReceiverNonce string `json:"receiverNonce"`
	NonceProof    string `json:"nonceProof"`
}

func localTestTransfer(t *testing.T) (invitation, *localResume, string) {
	t.Helper()
	invite, err := newInvitation(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	local := newLocalResume(invite, time.Now().Add(time.Hour).UnixMilli())
	server := httptest.NewServer(local)
	t.Cleanup(func() { local.Close(); server.Close() })
	return invite, local, "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/v2/" + invite.encodedID()
}
func makeLocalJoin(t *testing.T, invite invitation) localReceiverJoin {
	t.Helper()
	nonce, err := resumeRandom()
	if err != nil {
		t.Fatal(err)
	}
	token, err := resumeReceiverAdmission(invite)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := resumeNonceProof(invite, "receiver", nonce)
	if err != nil {
		t.Fatal(err)
	}
	return localReceiverJoin{"join", resumeProtocol, "receiver", resumeEncoded(token), resumeEncoded(nonce), resumeEncoded(proof)}
}
func localTestSocket(t *testing.T, endpoint string) *websocket.Conn {
	t.Helper()
	socket, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { socket.Close() })
	socket.SetReadDeadline(time.Now().Add(2 * time.Second))
	return socket
}
func admitLocalReceiver(t *testing.T, invite invitation, local *localResume, endpoint string, join localReceiverJoin) (*resumeSession, *resumeSession) {
	t.Helper()
	socket := localTestSocket(t, endpoint)
	if err := socket.WriteJSON(join); err != nil {
		t.Fatal(err)
	}
	var accepted, paired resumeEvent
	if err := socket.ReadJSON(&accepted); err != nil {
		t.Fatal(err)
	}
	if accepted.Type != "accepted" || accepted.Protocol != resumeProtocol || accepted.ExpiresAt != local.expiresAt {
		t.Fatalf("wrong admission: %+v", accepted)
	}
	if err := socket.ReadJSON(&paired); err != nil {
		t.Fatal(err)
	}
	if paired.Type != "peer-joined" || paired.ReceiverNonce != join.ReceiverNonce {
		t.Fatalf("wrong pairing: %+v", paired)
	}
	senderNonce, err := resumeDecode(paired.SessionNonce, 32)
	if err != nil {
		t.Fatal(err)
	}
	receiverNonce, err := resumeDecode(paired.ReceiverNonce, 32)
	if err != nil {
		t.Fatal(err)
	}
	senderProof, err := resumeDecode(paired.SenderNonceProof, 32)
	if err != nil || !verifyResumeNonceProof(invite, "sender", senderNonce, senderProof) {
		t.Fatal("sender's fresh nonce was not authenticated")
	}
	seal, err := newResumeSealer(invite, senderNonce, receiverNonce, receiverDirection)
	if err != nil {
		t.Fatal(err)
	}
	open, err := newResumeOpener(invite, senderNonce, receiverNonce, senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	receiver := &resumeSession{socket: socket, seal: seal, open: open, senderNonce: paired.SessionNonce, receiverNonce: paired.ReceiverNonce, expiresAt: accepted.ExpiresAt}
	select {
	case sender := <-local.Sessions:
		if !sender.local || sender.localDone == nil {
			t.Fatal("session lacks local lifecycle")
		}
		return sender, receiver
	case <-time.After(time.Second):
		t.Fatal("no sender session")
		return nil, nil
	}
}
func waitLocalIdle(t *testing.T, local *localResume) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		local.mu.Lock()
		idle := local.active == nil
		local.mu.Unlock()
		if idle {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("local session did not release")
}
func TestLocalResumeAuthenticatedEncryptedHandshakeAndCompletion(t *testing.T) {
	invite, local, endpoint := localTestTransfer(t)
	sender, receiver := admitLocalReceiver(t, invite, local, endpoint, makeLocalJoin(t, invite))
	defer sender.close()
	if err := sender.send(kindOffer, []byte("encrypted offer")); err != nil {
		t.Fatal(err)
	}
	kind, data, err := receiver.next()
	if err != nil || kind != kindOffer || string(data) != "encrypted offer" {
		t.Fatalf("local offer: kind %v data %q error %v", kind, data, err)
	}
	if err = receiver.send(kindAccept, []byte("durable offset")); err != nil {
		t.Fatal(err)
	}
	kind, data, err = sender.next()
	if err != nil || kind != kindAccept || string(data) != "durable offset" {
		t.Fatalf("local accept: kind %v data %q error %v", kind, data, err)
	}
	terminal := make(chan error, 1)
	go func() { terminal <- sender.terminal(false) }()
	if err = receiver.terminal(true); err != nil {
		t.Fatal(err)
	}
	if err = <-terminal; err != nil {
		t.Fatal(err)
	}
}
func TestLocalResumeFreshSessionKeysRejectReplayAndConcurrentReceiver(t *testing.T) {
	invite, local, endpoint := localTestTransfer(t)
	join := makeLocalJoin(t, invite)
	sender, receiver := admitLocalReceiver(t, invite, local, endpoint, join)
	record, err := sender.seal.seal(kindOffer, []byte("same bytes"))
	if err != nil {
		t.Fatal(err)
	}
	duplicate := localTestSocket(t, endpoint)
	duplicate.WriteJSON(makeLocalJoin(t, invite))
	if _, _, err = duplicate.ReadMessage(); err == nil {
		t.Fatal("concurrent receiver replaced active connection")
	}
	sender.close()
	receiver.socket.Close()
	waitLocalIdle(t, local)
	replay := localTestSocket(t, endpoint)
	replay.WriteJSON(join)
	if _, _, err = replay.ReadMessage(); err == nil {
		t.Fatal("old receiver nonce accepted on reconnect")
	}
	nextSender, nextReceiver := admitLocalReceiver(t, invite, local, endpoint, makeLocalJoin(t, invite))
	defer nextSender.close()
	if nextSender.senderNonce == sender.senderNonce || nextSender.receiverNonce == sender.receiverNonce {
		t.Fatal("fresh reconnect reused nonce")
	}
	nextRecord, err := nextSender.seal.seal(kindOffer, []byte("same bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(record, nextRecord) {
		t.Fatal("new session reused ciphertext at sequence zero")
	}
	if _, _, err = nextReceiver.open.open(record); err == nil {
		t.Fatal("new session accepted old encrypted record")
	}
	if _, data, err := nextReceiver.open.open(nextRecord); err != nil || string(data) != "same bytes" {
		t.Fatalf("new encrypted record: %q %v", data, err)
	}
}
func TestLocalResumeRejectsInvalidCredentialsAndMalformedJoins(t *testing.T) {
	invite, local, endpoint := localTestTransfer(t)
	for _, mutate := range []func(*localReceiverJoin){func(j *localReceiverJoin) { j.ReceiverToken = resumeEncoded(make([]byte, 32)) }, func(j *localReceiverJoin) { j.NonceProof = resumeEncoded(make([]byte, 32)) }, func(j *localReceiverJoin) { j.Role = "sender" }, func(j *localReceiverJoin) { j.Protocol = "cd-transfer-v1" }, func(j *localReceiverJoin) { j.ReceiverNonce = "malformed" }} {
		socket := localTestSocket(t, endpoint)
		join := makeLocalJoin(t, invite)
		mutate(&join)
		socket.WriteJSON(join)
		if _, _, err := socket.ReadMessage(); err == nil {
			t.Fatal("malformed or unauthenticated receiver admitted")
		}
		select {
		case <-local.Sessions:
			t.Fatal("unauthenticated session exposed to sender")
		default:
		}
	}
	sender, _ := admitLocalReceiver(t, invite, local, endpoint, makeLocalJoin(t, invite))
	defer sender.close()
}
func TestLocalResumeRejectsExpiredWrongPathAndOversizedJoin(t *testing.T) {
	invite, local, endpoint := localTestTransfer(t)
	socket := localTestSocket(t, endpoint)
	socket.WriteMessage(websocket.TextMessage, make([]byte, 2049))
	if _, _, err := socket.ReadMessage(); err == nil {
		t.Fatal("oversized join accepted")
	}
	connection, response, err := websocket.DefaultDialer.Dial(endpoint+"wrong", nil)
	if connection != nil {
		connection.Close()
	}
	if err == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong path: %+v %v", response, err)
	}
	local.Close()
	socket = localTestSocket(t, endpoint)
	socket.WriteJSON(makeLocalJoin(t, invite))
	if _, _, err = socket.ReadMessage(); err == nil {
		t.Fatal("closed local transfer admitted receiver")
	}
	expired := newLocalResume(invite, time.Now().Add(-time.Second).UnixMilli())
	server := httptest.NewServer(expired)
	defer server.Close()
	response, err = http.Get(server.URL + "/ws/v2/" + invite.encodedID())
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusGone {
		t.Fatal("expired transfer did not return gone")
	}
}
func TestLocalResumeSessionLimit(t *testing.T) {
	invite, local, endpoint := localTestTransfer(t)
	local.mu.Lock()
	for i := range 128 {
		local.nonces[string(rune(i))] = true
	}
	local.mu.Unlock()
	socket := localTestSocket(t, endpoint)
	socket.WriteJSON(makeLocalJoin(t, invite))
	if _, _, err := socket.ReadMessage(); err == nil {
		t.Fatal("session history exceeded bound")
	}
}
func TestLocalResumeProofBindsTransferAndRole(t *testing.T) {
	invite, local, endpoint := localTestTransfer(t)
	other, err := newInvitation(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	join := makeLocalJoin(t, invite)
	nonce, _ := resumeDecode(join.ReceiverNonce, 32)
	wrongProof, _ := resumeNonceProof(other, "receiver", nonce)
	join.NonceProof = resumeEncoded(wrongProof)
	socket := localTestSocket(t, endpoint)
	b, _ := json.Marshal(join)
	socket.WriteMessage(websocket.TextMessage, b)
	if _, _, err = socket.ReadMessage(); err == nil {
		t.Fatal("other transfer nonce proof accepted")
	}
	select {
	case <-local.Sessions:
		t.Fatal("wrong proof exposed session")
	default:
	}
}
