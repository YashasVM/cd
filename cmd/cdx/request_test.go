package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRequestIDParsing(t *testing.T) {
	for _, args := range [][]string{{"--request-id", "run.123", "file"}, {"file", "--request-id=run.123"}} {
		request, err := parseSendArgs(args)
		if err != nil || request.requestID != "run.123" {
			t.Fatalf("%v: %#v %v", args, request, err)
		}
	}
	for _, args := range [][]string{{"--request-id", "../a", "file"}, {"--request-id=", "file"}, {"--request-id", "a", "--wait", "file"}} {
		if _, err := parseSendArgs(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestRequestFingerprintSeparatesInputsAndIgnoresPresentation(t *testing.T) {
	t.Setenv("CD_RELAY_URL", "ws://127.0.0.1:9999/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "http://127.0.0.1:9999")
	path := filepath.Join(t.TempDir(), "a.txt")
	os.WriteFile(path, []byte("first"), 0600)
	request := sendRequest{files: []string{path}}
	first, err := requestFingerprint(request)
	if err != nil {
		t.Fatal(err)
	}
	request.jsonOutput = true
	request.progress = true
	same, err := requestFingerprint(request)
	if err != nil || same != first {
		t.Fatalf("presentation changed identity: %v", err)
	}
	request.linkMode = true
	different, _ := requestFingerprint(request)
	if different == first {
		t.Fatal("link semantics reused identity")
	}
	request.linkMode = false
	os.WriteFile(path, []byte("other"), 0600)
	different, _ = requestFingerprint(request)
	if different == first {
		t.Fatal("changed bytes reused identity")
	}
}

func TestRequestLockReleasedAndWaitingCanCancel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.lock")
	unlock, err := lockRequest(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if next, err := lockRequest(ctx, path); err == nil {
		next()
		t.Fatal("second holder acquired locked request")
	} else if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	unlock()
	next, err := lockRequest(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	next()
}

func TestRequestJournalRejectsMismatchedIdentityAndIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.json")
	secret := make([]byte, invitationBytes)
	secret[0] = 42
	journal := requestJournal{Version: 1, Fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Invitation: base64.RawURLEncoding.EncodeToString(secret), StartedAt: time.Now()}
	if err := writeRequestJournal(path, journal); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	t.Setenv("CD_REQUEST_JOURNAL", path)

	ready := readyOutput{Version: 1, TransferID: base64.RawURLEncoding.EncodeToString(secret[:16]), URL: "https://cd.yash0.in/s/" + base64.RawURLEncoding.EncodeToString(secret[:16]) + "#v1." + base64.RawURLEncoding.EncodeToString(secret[16:])}
	if err := recordRequestReady(ready); err != nil {
		t.Fatal(err)
	}
	read, err := readRequestJournal(path)
	if err != nil || read.PID != os.Getpid() || read.Ready.URL != ready.URL {
		t.Fatalf("%#v %v", read, err)
	}
	journal.Ready = &ready
	journal.Ready.TransferID = "incorrect"
	writeRequestJournal(path, journal)
	if _, err := readRequestJournal(path); err == nil {
		t.Fatal("accepted mismatched reservation")
	}
}

func TestRequestHolderRejectsSourceChangedAfterReservation(t *testing.T) {
	t.Setenv("CD_RELAY_URL", "ws://127.0.0.1:9999/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "http://127.0.0.1:9999")
	dir := t.TempDir()
	source := filepath.Join(dir, "source.bin")
	os.WriteFile(source, []byte("first"), 0600)
	request := sendRequest{files: []string{source}}
	fingerprint, digest, err := requestMaterial(request)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, invitationBytes)
	journal := requestJournal{Version: 1, Fingerprint: fingerprint, PayloadHash: digest, Invitation: base64.RawURLEncoding.EncodeToString(secret), StartedAt: time.Now()}
	path := filepath.Join(dir, "request.json")
	writeRequestJournal(path, journal)
	t.Setenv("CD_REQUEST_JOURNAL", path)
	if err := recordRequestHolder(request); err != nil {
		t.Fatal(err)
	}
	if err := verifyRequestPayload(digest); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(source, []byte("other"), 0600)
	if err := recordRequestHolder(request); classifyFailure(err) != "request_conflict" {
		t.Fatalf("accepted changed source: %v", err)
	}
	if err := verifyRequestPayload("different"); classifyFailure(err) != "request_conflict" {
		t.Fatalf("accepted different sent bytes: %v", err)
	}
}

func TestRequestFingerprintSeparatesRelativeQRDirectories(t *testing.T) {
	t.Setenv("CD_RELAY_URL", "ws://127.0.0.1:9999/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "http://127.0.0.1:9999")
	dir := t.TempDir()
	source := filepath.Join(dir, "a.txt")
	os.WriteFile(source, []byte("same"), 0600)
	firstDir := filepath.Join(dir, "first")
	secondDir := filepath.Join(dir, "second")
	os.Mkdir(firstDir, 0700)
	os.Mkdir(secondDir, 0700)
	request := sendRequest{files: []string{source}, qrPath: "code.png"}
	t.Chdir(firstDir)
	first, err := requestFingerprint(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(secondDir)
	second, err := requestFingerprint(request)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("different QR destinations reused request identity")
	}
}
