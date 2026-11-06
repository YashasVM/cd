package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/YashasVM/cd/internal/devices"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func pendingCapabilityFixture(t *testing.T) (resumeCapability, string, string) {
	t.Helper()
	t.Setenv("CD_STATE_DIR", t.TempDir())
	checkpoint, master, _ := checkpointFixture(t, t.TempDir())
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		t.Fatal(err)
	}
	checkpoint.Role = "sender"
	checkpoint.StagingID = "sender"
	checkpoint.Destination = "sender"
	checkpoint.Offset = 0
	empty := sha256.Sum256(nil)
	checkpoint.PrefixSHA256 = hex.EncodeToString(empty[:])
	if err := signResumeCheckpoint(&checkpoint, token); err != nil {
		t.Fatal(err)
	}
	capability := resumeCapability{Version: 2, Master: resumeEncoded(master), SenderToken: resumeEncoded(token), Checkpoint: checkpoint}
	capabilityPath, err := resumeCapabilityPath(checkpoint.RootID)
	if err != nil {
		t.Fatal(err)
	}
	if err = resumeAtomicJSON(capabilityPath, capability); err != nil {
		t.Fatal(err)
	}
	pending, err := devicePendingPath(checkpoint.RootID, []string{filepath.Join(t.TempDir(), "payload.bin")})
	if err != nil {
		t.Fatal(err)
	}
	return capability, capabilityPath, pending
}

func TestDevicePendingRetainsAuthenticatedRootAcrossReload(t *testing.T) {
	capability, _, path := pendingCapabilityFixture(t)
	id := capability.Checkpoint.RootID
	expiry := capability.Checkpoint.ExpiresAt
	if err := saveDevicePending(path, id, expiry); err != nil {
		t.Fatal(err)
	}
	if err := saveDevicePending(path, id, expiry); err != nil {
		t.Fatal("repeated save failed:", err)
	}
	got, err := loadDevicePending(path)
	if err != nil || got != id {
		t.Fatalf("reloaded pending root %q: %v", got, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("pending record permissions: %v %v", info, err)
	}
	info, err = os.Stat(filepath.Dir(path))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("pending directory permissions: %v %v", info, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{capability.Master, capability.SenderToken, capability.Checkpoint.Filename} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatalf("pending record exposes private source or credential")
		}
	}
	var record map[string]any
	if err = json.Unmarshal(data, &record); err != nil || len(record) != 3 {
		t.Fatalf("unexpected pending record: %s %v", data, err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("atomic save leaked temporary files: %v %v", entries, err)
	}
}
func TestDevicePendingPathCanonicalAliasesAndIsolation(t *testing.T) {
	t.Setenv("CD_STATE_DIR", t.TempDir())
	pairA := "aO6Ww6lyA10XmqHEgQYHyA"
	pairB := "AAECAwQFBgcICQoLDA0ODw"
	first := filepath.Join(t.TempDir(), "first.bin")
	second := filepath.Join(t.TempDir(), "second.bin")
	base, err := devicePendingPath(pairA, []string{first, second})
	if err != nil {
		t.Fatal(err)
	}
	alias := filepath.Dir(first) + string(filepath.Separator) + "unused" + string(filepath.Separator) + ".." + string(filepath.Separator) + filepath.Base(first)
	same, err := devicePendingPath(pairA, []string{alias, second})
	if err != nil || same != base {
		t.Fatalf("canonical path alias changed intent: %q %q %v", same, base, err)
	}
	relative, err := filepath.Rel(".", first)
	if err != nil {
		absoluteCWD, _ := os.Getwd()
		relative, err = filepath.Rel(absoluteCWD, first)
	}
	if err != nil {
		t.Fatal(err)
	}
	same, err = devicePendingPath(pairA, []string{relative, second})
	if err != nil || same != base {
		t.Fatal("relative source changed intent identity")
	}
	for _, test := range []struct {
		pair  string
		files []string
	}{{pairB, []string{first, second}}, {pairA, []string{first}}, {pairA, []string{second, first}}, {pairA, []string{first + "-renamed", second}}} {
		path, err := devicePendingPath(test.pair, test.files)
		if err != nil || path == base {
			t.Fatalf("different pair/source shared an intent path: %q %v", path, err)
		}
	}
	if strings.Contains(filepath.Base(base), "first") || strings.Contains(base, pairA) {
		t.Fatal("pending path exposes source path or pair identity")
	}
	for _, files := range [][]string{nil, {""}, {"-"}} {
		if _, err := devicePendingPath(pairA, files); err == nil {
			t.Fatal("invalid source paths accepted")
		}
	}
	if _, err := devicePendingPath("nickname", []string{first}); err == nil {
		t.Fatal("name accepted as pair identity")
	}
}
func TestDevicePendingMissingAndExpiredStateIsIgnored(t *testing.T) {
	for _, test := range []string{"missing pending", "expired pending", "missing capability", "expired capability"} {
		t.Run(test, func(t *testing.T) {
			capability, capabilityPath, path := pendingCapabilityFixture(t)
			id := capability.Checkpoint.RootID
			if test == "missing pending" {
				if got, err := loadDevicePending(path); err != nil || got != "" {
					t.Fatalf("missing pending: %q %v", got, err)
				}
				return
			}
			if err := saveDevicePending(path, id, capability.Checkpoint.ExpiresAt); err != nil {
				t.Fatal(err)
			}
			switch test {
			case "expired pending":
				if err := resumeAtomicJSON(path, devicePending{1, id, time.Now().Add(-time.Second).UnixMilli()}); err != nil {
					t.Fatal(err)
				}
			case "missing capability":
				if err := os.Remove(capabilityPath); err != nil {
					t.Fatal(err)
				}
			case "expired capability":
				capability.Checkpoint.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
				token, _ := resumeDecode(capability.SenderToken, 32)
				if err := signResumeCheckpoint(&capability.Checkpoint, token); err != nil {
					t.Fatal(err)
				}
				if err := resumeAtomicJSON(capabilityPath, capability); err != nil {
					t.Fatal(err)
				}
			}
			if got, err := loadDevicePending(path); err != nil || got != "" {
				t.Fatalf("stale pending: %q %v", got, err)
			}
		})
	}
}
func TestDevicePendingCorruptionAndUnsafePermissionsFail(t *testing.T) {
	for _, test := range []string{"invalid JSON", "invalid version", "invalid root", "invalid expiry", "wrong record permissions", "oversized metadata", "symlink record", "wrong directory permissions", "tampered capability", "tampered expired capability", "expiry mismatch"} {
		t.Run(test, func(t *testing.T) {
			capability, capabilityPath, path := pendingCapabilityFixture(t)
			id := capability.Checkpoint.RootID
			if err := saveDevicePending(path, id, capability.Checkpoint.ExpiresAt); err != nil {
				t.Fatal(err)
			}
			switch test {
			case "invalid JSON":
				os.WriteFile(path, []byte("{"), 0600)
			case "invalid version":
				resumeAtomicJSON(path, devicePending{2, id, capability.Checkpoint.ExpiresAt})
			case "invalid root":
				resumeAtomicJSON(path, devicePending{1, "nickname", capability.Checkpoint.ExpiresAt})
			case "invalid expiry":
				resumeAtomicJSON(path, devicePending{1, id, -1})
			case "wrong record permissions":
				os.Chmod(path, 0644)
			case "oversized metadata":
				os.WriteFile(path, make([]byte, 16385), 0600)
			case "symlink record":
				outside := filepath.Join(t.TempDir(), "outside.json")
				if err := os.Rename(path, outside); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
			case "wrong directory permissions":
				os.Chmod(filepath.Dir(path), 0755)
			case "tampered capability":
				capability.Checkpoint.PrefixSHA256 = strings.Repeat("a", 64)
				resumeAtomicJSON(capabilityPath, capability)
			case "tampered expired capability":
				capability.Checkpoint.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
				resumeAtomicJSON(capabilityPath, capability)
			case "expiry mismatch":
				resumeAtomicJSON(path, devicePending{1, id, capability.Checkpoint.ExpiresAt - 1})
			}
			if got, err := loadDevicePending(path); err == nil || got != "" {
				t.Fatalf("corrupted pending silently accepted: %q %v", got, err)
			}
		})
	}
}
func TestDevicePendingSaveRequiresAuthenticatedLiveCapability(t *testing.T) {
	capability, capabilityPath, path := pendingCapabilityFixture(t)
	id := capability.Checkpoint.RootID
	expiry := capability.Checkpoint.ExpiresAt
	for _, test := range []struct {
		path, id string
		expiry   int64
	}{{path, "nickname", expiry}, {path, id, 0}, {path, id, time.Now().Add(-time.Second).UnixMilli()}, {path, id, expiry + 1}, {filepath.Join(t.TempDir(), "outside.json"), id, expiry}} {
		if err := saveDevicePending(test.path, test.id, test.expiry); err == nil {
			t.Fatalf("invalid intent save accepted: %+v", test)
		}
	}
	if err := os.Remove(capabilityPath); err != nil {
		t.Fatal(err)
	}
	if err := saveDevicePending(path, id, expiry); err == nil {
		t.Fatal("saved intent without private capability")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("failed save published an intent")
	}
}

func TestDevicePendingRerunRejectsChangedSourceBeforeConnecting(t *testing.T) {
	capability, capabilityPath, path := pendingCapabilityFixture(t)
	source := filepath.Join(t.TempDir(), "payload.bin")
	original := bytes.Repeat([]byte{0x42}, 2*chunkSize)
	if err := os.WriteFile(source, original, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(original)
	capability.Checkpoint.WholeSHA256 = hex.EncodeToString(digest[:])
	token, _ := resumeDecode(capability.SenderToken, 32)
	if err := signResumeCheckpoint(&capability.Checkpoint, token); err != nil {
		t.Fatal(err)
	}
	if err := resumeAtomicJSON(capabilityPath, capability); err != nil {
		t.Fatal(err)
	}
	if err := saveDevicePending(path, capability.Checkpoint.RootID, capability.Checkpoint.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	original[len(original)-1] ^= 1
	if err := os.WriteFile(source, original, 0600); err != nil {
		t.Fatal(err)
	}
	id, err := loadDevicePending(path)
	if err != nil {
		t.Fatal(err)
	}
	connected := false
	err = sendResumable(context.Background(), sendRequest{
		resumeID: id, files: []string{source},
		deviceConnect: func(context.Context, invitation, []byte, int64, readyOutput, string) (*resumeSession, error) {
			connected = true
			return nil, context.Canceled
		},
	})
	if err == nil || !strings.Contains(err.Error(), "resume source changed") || connected {
		t.Fatalf("changed source rerun: connected=%v error=%v", connected, err)
	}
	retained, err := loadDevicePending(path)
	if err != nil || retained != id {
		t.Fatalf("failed rerun discarded pending intent: %q %v", retained, err)
	}
}

func TestDeviceReceiptRecoveryFinishesOnlyMatchingPendingRoot(t *testing.T) {
	t.Setenv("CD_STATE_DIR", t.TempDir())
	t.Setenv("CD_RELAY_URL", "wss://cd.yash0.in/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "https://cd.yash0.in")
	path := filepath.Join(t.TempDir(), "payload.bin")
	contents := bytes.Repeat([]byte("verified bytes"), 50000)
	if err := os.WriteFile(path, contents, 0600); err != nil {
		t.Fatal(err)
	}
	pending, err := devicePendingPath("aO6Ww6lyA10XmqHEgQYHyA", []string{path})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var originalID string
	first := sendRequest{files: []string{path}, deviceConnect: func(_ context.Context, invite invitation, _ []byte, expiry int64, _ readyOutput, _ string) (*resumeSession, error) {
		originalID = invite.encodedID()
		if err := saveDevicePending(pending, originalID, expiry); err != nil {
			return nil, err
		}
		return nil, NewFailure(failureDisconnected, "final COMPLETE was lost", retrySameRequest)
	}}
	if err = sendResumable(ctx, first); err == nil {
		t.Fatal("lost final completion reported success")
	}
	retained, err := loadDevicePending(pending)
	if err != nil || retained != originalID {
		t.Fatalf("interrupted intent: %q %v", retained, err)
	}
	wrongID := "AAECAwQFBgcICQoLDA0ODw"
	if confirmed, err := finishDeviceReceipt(pending, wrongID, []string{path}); err != nil || confirmed {
		t.Fatalf("wrong root completed pending send: %v %v", confirmed, err)
	}
	receipts := make(chan string, 2)
	retry := sendRequest{files: []string{path}, resumeID: retained, deviceConnect: func(callCtx context.Context, invite invitation, _ []byte, _ int64, _ readyOutput, _ string) (*resumeSession, error) {
		if invite.encodedID() != originalID {
			return nil, errors.New("retry created another transfer")
		}
		receipts <- wrongID
		select {
		case <-callCtx.Done():
			return nil, errors.New("wrong root canceled the attempt")
		case <-time.After(20 * time.Millisecond):
		}
		receipts <- originalID
		<-callCtx.Done()
		return nil, callCtx.Err()
	}}
	err, receivedID := sendDeviceAttempt(ctx, retry, receipts)
	if err == nil || receivedID != originalID || ctx.Err() != nil {
		t.Fatalf("trusted receipt did not interrupt only its attempt: id=%q error=%v parent=%v", receivedID, err, ctx.Err())
	}
	if confirmed, err := finishDeviceReceipt(pending, receivedID, []string{path}); err != nil || !confirmed {
		t.Fatalf("matching receipt did not finish: %v %v", confirmed, err)
	}
	capability, _ := resumeCapabilityPath(originalID)
	for _, state := range []string{pending, capability} {
		if _, err := os.Stat(state); !os.IsNotExist(err) {
			t.Fatalf("completed receipt retained state %s: %v", state, err)
		}
	}
	actual, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(actual, contents) {
		t.Fatal("receipt cleanup changed source")
	}
}

func TestDeviceReceiptCannotBypassSourceIdentity(t *testing.T) {
	capability, capabilityPath, pending := pendingCapabilityFixture(t)
	source := filepath.Join(t.TempDir(), "payload.bin")
	contents := bytes.Repeat([]byte{0x42}, 2*chunkSize)
	if err := os.WriteFile(source, contents, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	capability.Checkpoint.WholeSHA256 = hex.EncodeToString(digest[:])
	token, _ := resumeDecode(capability.SenderToken, 32)
	if err := signResumeCheckpoint(&capability.Checkpoint, token); err != nil {
		t.Fatal(err)
	}
	if err := resumeAtomicJSON(capabilityPath, capability); err != nil {
		t.Fatal(err)
	}
	if err := saveDevicePending(pending, capability.Checkpoint.RootID, capability.Checkpoint.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	contents[len(contents)-1] ^= 1
	if err := os.WriteFile(source, contents, 0600); err != nil {
		t.Fatal(err)
	}
	if confirmed, err := finishDeviceReceipt(pending, capability.Checkpoint.RootID, []string{source}); err == nil || confirmed {
		t.Fatalf("trusted receipt completed changed content: %v %v", confirmed, err)
	}
	for _, state := range []string{pending, capabilityPath} {
		if _, err := os.Stat(state); err != nil {
			t.Fatalf("failed receipt discarded retained state: %v", err)
		}
	}
}

func TestDevicePeerPrefersLANWithinPhoneReconnectPeriodAndBoundsRemoteFallback(t *testing.T) {
	pair, err := devices.NewPair("laptop", "wss://cd.yash0.in", nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	local, err := devices.NewServer(pair)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	server := httptest.NewServer(local)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	peer, err := devices.DialLocal(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/devices/v1/"+pair.PairID, pair, devices.Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	remote := deviceMessage{peer: peer, message: devices.Message{Type: "paired", Name: "phone"}}
	incoming := make(chan deviceMessage, 2)
	incoming <- remote
	arrived := make(chan struct{})
	go func() {
		defer close(arrived)
		select {
		case <-time.After(1100 * time.Millisecond):
		case <-ctx.Done():
			return
		}
		lan := remote
		lan.local = true
		select {
		case incoming <- lan:
		case <-ctx.Done():
		}
	}()
	selected, _, err := awaitDevicePeer(ctx, incoming, nil)
	<-arrived
	if err != nil || !selected.local {
		t.Fatalf("LAN reconnect was skipped for relay: local=%v error=%v", selected.local, err)
	}
	incoming <- remote
	start := time.Now()
	selected, _, err = awaitDevicePeer(ctx, incoming, nil)
	if err != nil || selected.local || time.Since(start) > 4*time.Second {
		t.Fatalf("remote fallback did not stay bounded: local=%v elapsed=%s error=%v", selected.local, time.Since(start), err)
	}
}
