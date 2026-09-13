package main

import (
	"bytes"
	"testing"
)

func testInvitation() invitation {
	var value invitation
	for index := range value.id {
		value.id[index] = byte(index)
	}
	for index := range value.key {
		value.key[index] = byte(index + 32)
	}
	return value
}

func TestRecordRoundTripPreservesKindAndBytes(t *testing.T) {
	value := testInvitation()
	sealer, err := newSealer(value, senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	opener, err := newOpener(value, senderDirection)
	if err != nil {
		t.Fatal(err)
	}

	record, err := sealer.seal(kindChunk, []byte("exact bytes"))
	if err != nil {
		t.Fatal(err)
	}
	kind, plaintext, err := opener.open(record)
	if err != nil {
		t.Fatal(err)
	}
	if kind != kindChunk || !bytes.Equal(plaintext, []byte("exact bytes")) {
		t.Fatalf("opened kind %d and bytes %q", kind, plaintext)
	}
}

func TestRecordRejectsChangedCiphertext(t *testing.T) {
	value := testInvitation()
	sealer, _ := newSealer(value, senderDirection)
	opener, _ := newOpener(value, senderDirection)
	record, err := sealer.seal(kindChunk, []byte("exact bytes"))
	if err != nil {
		t.Fatal(err)
	}
	record[len(record)-1] ^= 1
	if _, _, err := opener.open(record); err == nil {
		t.Fatal("changed ciphertext was accepted")
	}
}

func TestRecordRejectsSkippedSequence(t *testing.T) {
	value := testInvitation()
	sealer, _ := newSealer(value, senderDirection)
	opener, _ := newOpener(value, senderDirection)
	first, _ := sealer.seal(kindChunk, []byte("first"))
	second, _ := sealer.seal(kindChunk, []byte("second"))

	if _, _, err := opener.open(second); err == nil {
		t.Fatal("skipped sequence was accepted")
	}
	if _, plaintext, err := opener.open(first); err != nil || !bytes.Equal(plaintext, []byte("first")) {
		t.Fatalf("expected sequence stopped working after rejection: %q, %v", plaintext, err)
	}
}

func TestInvitationUsesStrongCanonicalParts(t *testing.T) {
	value, err := newInvitation(bytes.NewReader(make([]byte, invitationBytes)))
	if err != nil {
		t.Fatal(err)
	}
	if len(value.encodedID()) != 22 {
		t.Fatalf("transfer id length = %d", len(value.encodedID()))
	}
	if len(value.encodedKey()) != 43 {
		t.Fatalf("master key length = %d", len(value.encodedKey()))
	}
	token, err := value.receiverToken()
	if err != nil {
		t.Fatal(err)
	}
	tokenHash, err := value.receiverTokenHash()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 32 || len(tokenHash) != 32 {
		t.Fatal("receiver admission values must be 256 bits")
	}
}
