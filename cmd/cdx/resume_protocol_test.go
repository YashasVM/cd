package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestResumeV2FixtureAndProofs(t *testing.T) {
	var f struct {
		Invitation struct {
			RootID    string `json:"rootId"`
			MasterKey string `json:"masterKey"`
		} `json:"invitation"`
		SessionNonce, ReceiverNonce, Plaintext, Record string
	}
	b, err := os.ReadFile("../../fixtures/resume-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	id, _ := base64.RawURLEncoding.DecodeString(f.Invitation.RootID)
	key, _ := base64.RawURLEncoding.DecodeString(f.Invitation.MasterKey)
	sn, _ := base64.RawURLEncoding.DecodeString(f.SessionNonce)
	rn, _ := base64.RawURLEncoding.DecodeString(f.ReceiverNonce)
	var inv invitation
	copy(inv.id[:], id)
	copy(inv.key[:], key)
	sealer, err := newResumeSealer(inv, sn, rn, senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	record, err := sealer.seal(kindOffer, []byte(f.Plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.RawURLEncoding.EncodeToString(record); got != f.Record {
		t.Fatalf("record fixture mismatch: %s", got)
	}
	opener, err := newResumeOpener(inv, sn, rn, senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	kind, plain, err := opener.open(record)
	if err != nil || kind != kindOffer || string(plain) != f.Plaintext {
		t.Fatalf("open: %v %v %q", kind, err, plain)
	}
	proof, err := resumeNonceProof(inv, "sender", sn)
	if err != nil || !verifyResumeNonceProof(inv, "sender", sn, proof) || verifyResumeNonceProof(inv, "receiver", sn, proof) {
		t.Fatal("nonce proof verification failed")
	}
}
