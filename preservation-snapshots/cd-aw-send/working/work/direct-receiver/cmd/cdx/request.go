package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

type requestJournal struct {
	Version     int          `json:"version"`
	Fingerprint string       `json:"fingerprint"`
	PayloadHash string       `json:"payloadHash"`
	Invitation  string       `json:"invitation"`
	PID         int          `json:"pid,omitempty"`
	Ready       *readyOutput `json:"ready,omitempty"`
	StartedAt   time.Time    `json:"startedAt"`
}

func invitationForRequest() (invitation, error) {
	encoded := os.Getenv("CD_REQUEST_INVITATION")
	if encoded == "" {
		return newInvitation(rand.Reader)
	}
	bytes, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(bytes) != invitationBytes {
		return invitation{}, NewFailure(failureProtocol, "invalid request transfer reservation", retryNever)
	}
	var value invitation
	copy(value.id[:], bytes[:16])
	copy(value.key[:], bytes[16:])
	return value, nil
}

func writeRequestJournal(path string, journal requestJournal) error {
	data, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".request-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

func readRequestJournal(path string) (requestJournal, error) {
	var journal requestJournal
	file, err := os.Open(path)
	if err != nil {
		return journal, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 16*1024))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&journal); err != nil {
		return journal, err
	}
	_, fingerprintErr := hex.DecodeString(journal.Fingerprint)
	if journal.Version != 1 || fingerprintErr != nil || len(journal.Fingerprint) != 64 || journal.StartedAt.IsZero() || journal.PID < 0 {
		return journal, errors.New("invalid request journal")
	}
	secret, err := base64.RawURLEncoding.DecodeString(journal.Invitation)
	if err != nil || len(secret) != invitationBytes {
		return journal, errors.New("invalid request reservation")
	}
	if journal.Ready != nil {
		expectedID := base64.RawURLEncoding.EncodeToString(secret[:16])
		expectedKey := base64.RawURLEncoding.EncodeToString(secret[16:])
		capability, err := parseInvitationURL(journal.Ready.URL)
		if journal.Ready.TransferID != expectedID || journal.Ready.Version != 1 || err != nil || capability.encodedID() != expectedID || capability.encodedKey() != expectedKey {
			return journal, errors.New("request result disagrees with reservation")
		}
	}
	return journal, nil
}

func recordRequestHolder(request sendRequest) error {
	path := os.Getenv("CD_REQUEST_JOURNAL")
	if path == "" {
		return nil
	}
	journal, err := readRequestJournal(path)
	if err != nil {
		return err
	}
	fingerprint, err := requestFingerprint(request)
	if err != nil {
		return err
	}
	if fingerprint != journal.Fingerprint {
		return NewFailure("request_conflict", "source changed after the request was reserved", retryNever)
	}
	journal.PID = os.Getpid()
	return writeRequestJournal(path, journal)
}

func recordRequestReady(ready readyOutput) error {
	path := os.Getenv("CD_REQUEST_JOURNAL")
	if path == "" {
		return nil
	}
	journal, err := readRequestJournal(path)
	if err != nil {
		return err
	}
	journal.PID = os.Getpid()
	journal.Ready = &ready
	return writeRequestJournal(path, journal)
}

func requestFingerprint(request sendRequest) (string, error) {
	fingerprint, _, err := requestMaterial(request)
	return fingerprint, err
}

func requestMaterial(request sendRequest) (string, string, error) {
	paths := make([]string, len(request.files))
	for i, path := range request.files {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return "", "", err
		}
		paths[i] = absolute
	}
	relay, public, err := endpointBase()
	if err != nil {
		return "", "", err
	}
	source, err := prepareSource(paths)
	if err != nil {
		return "", "", err
	}
	hash := sha256.New()
	payloadHash := sha256.New()
	qrPath := request.qrPath
	if qrPath != "" {
		qrPath, err = filepath.Abs(qrPath)
		if err != nil {
			return "", "", err
		}
	}
	description := struct {
		Paths                   []string
		Link                    bool
		QR, Relay, Public, Name string
		Size                    uint64
	}{paths, request.linkMode, qrPath, relay, public, source.name, source.size}
	if err = json.NewEncoder(hash).Encode(description); err != nil {
		return "", "", err
	}
	input, err := source.open()
	if err != nil {
		return "", "", err
	}
	count, copyErr := io.Copy(payloadHash, input)
	closeErr := input.Close()
	if copyErr != nil {
		return "", "", copyErr
	}
	if closeErr != nil {
		return "", "", closeErr
	}
	if uint64(count) != source.size {
		return "", "", NewFailure(failureLocal, "source changed while fingerprinting the request", retryNever)
	}
	digest := hex.EncodeToString(payloadHash.Sum(nil))
	hash.Write([]byte(digest))
	return hex.EncodeToString(hash.Sum(nil)), digest, nil
}

func runRequestSend(request sendRequest) int {
	fail := func(err error) int { reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput); return 1 }
	fingerprint, payloadHash, err := requestMaterial(request)
	if err != nil {
		return fail(err)
	}
	dir, err := stateDir()
	if err != nil {
		return fail(err)
	}
	dir = filepath.Join(dir, "requests")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return fail(err)
	}
	digest := sha256.Sum256([]byte(request.requestID))
	stem := hex.EncodeToString(digest[:])
	path := filepath.Join(dir, stem+".json")
	ctx, cancel := context.WithTimeout(context.Background(), readyWait)
	defer cancel()
	unlock, err := lockRequest(ctx, filepath.Join(dir, stem+".lock"))
	if err != nil {
		return fail(NewFailure(failureBusy, "another command is preparing this request; retry the same request ID", retrySameRequest, err))
	}
	defer unlock()
	journal, err := readRequestJournal(path)
	if err == nil {
		if journal.Fingerprint != fingerprint {
			return fail(NewFailure("request_conflict", "request ID is already reserved for different inputs or options", retryNever))
		}
		if journal.Ready == nil {
			if journal.PID > 0 && processAlive(journal.PID) {
				return fail(NewFailure(failureBusy, "this request is still preparing; retry the same request ID", retrySameRequest))
			}
			return fail(NewFailure(failureDisconnected, "the reserved request stopped before readiness; use a new request ID", retryNewTransfer))
		}
		stateDirectory, err := stateDir()
		if err != nil {
			return fail(err)
		}
		state, err := readState(stateDirectory, journal.Ready.TransferID)
		if err != nil {
			return fail(NewFailure(failureDisconnected, "the request's transfer state is unavailable; use a new request ID", retryNewTransfer, err))
		}
		state = effectiveState(stateDirectory, state)
		if state.Phase == phaseFailed {
			retry := state.Retry
			if retry == "" {
				retry = failureGuidance(NewFailure(state.ErrorKind, state.Error, ""))
			}
			return fail(NewFailure(state.ErrorKind, state.Error, retry))
		}
		ready := *journal.Ready
		if ready.Code != "" {
			alias, aliasErr := readState(stateDirectory, ready.Code)
			_, publicBase, endpointErr := endpointBase()
			lookupCtx, lookupCancel := context.WithTimeout(ctx, 3*time.Second)
			current, lookupErr := lookupShareCode(lookupCtx, publicBase, ready.Code)
			lookupCancel()
			if aliasErr != nil || alias.TransferID != ready.TransferID || endpointErr != nil || lookupErr != nil || current.encodedID() != ready.TransferID || current.encodedKey() != base64.RawURLEncoding.EncodeToString(secretFromJournal(journal)) {
				ready.Code = ""
			}
		}
		if err = writeReady(os.Stdout, ready, request.jsonOutput); err != nil {
			return fail(err)
		}
		return 0
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fail(NewFailure(failureLocal, "cannot read the request reservation; use a new request ID", retryNever, err))
	}
	value, err := newInvitation(rand.Reader)
	if err != nil {
		return fail(err)
	}
	secret := append(append([]byte{}, value.id[:]...), value.key[:]...)
	journal = requestJournal{Version: 1, Fingerprint: fingerprint, PayloadHash: payloadHash, Invitation: base64.RawURLEncoding.EncodeToString(secret), StartedAt: time.Now().UTC()}
	if err = writeRequestJournal(path, journal); err != nil {
		return fail(fmt.Errorf("record request reservation: %w", err))
	}
	// Holder inherits private reservation metadata; these are not output fields.
	previousPath, hadPath := os.LookupEnv("CD_REQUEST_JOURNAL")
	previousSecret, hadSecret := os.LookupEnv("CD_REQUEST_INVITATION")
	defer func() {
		if hadPath {
			os.Setenv("CD_REQUEST_JOURNAL", previousPath)
		} else {
			os.Unsetenv("CD_REQUEST_JOURNAL")
		}
		if hadSecret {
			os.Setenv("CD_REQUEST_INVITATION", previousSecret)
		} else {
			os.Unsetenv("CD_REQUEST_INVITATION")
		}
	}()
	os.Setenv("CD_REQUEST_JOURNAL", path)
	os.Setenv("CD_REQUEST_INVITATION", journal.Invitation)
	return runDetachedSend(request)
}

func verifyRequestPayload(digest string) error {
	path := os.Getenv("CD_REQUEST_JOURNAL")
	if path == "" {
		return nil
	}
	journal, err := readRequestJournal(path)
	if err != nil {
		return err
	}
	if journal.PayloadHash != digest {
		return NewFailure("request_conflict", "source content changed after request reservation; transfer was not completed", retryNever)
	}
	return nil
}

func secretFromJournal(journal requestJournal) []byte {
	secret, _ := base64.RawURLEncoding.DecodeString(journal.Invitation)
	return secret[16:]
}
