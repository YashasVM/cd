package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func identityFixture(id, code string) transferState {
	return transferState{Version: 1, TransferID: id, Code: code, Filename: "payload.bin", Size: 100, Phase: phaseWaiting, PID: os.Getpid(), StartedAt: time.Now().UTC()}
}

func rawState(t *testing.T, dir, key string, state transferState) {
	t.Helper()
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, key+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestStateCodeReusePreservesPinnedHistory(t *testing.T) {
	dir := t.TempDir()
	first := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
	second := identityFixture("bO6Ww6lyA10XmqHEgQYHyA", "12345")
	if err := writeState(dir, first); err != nil {
		t.Fatal(err)
	}
	if err := writeState(dir, second); err != nil {
		t.Fatal(err)
	}
	state, err := readState(dir, "12345")
	if err != nil || state.TransferID != second.TransferID {
		t.Fatalf("latest=%+v,%v", state, err)
	}
	state, err = readState(dir, first.TransferID)
	if err != nil || state.TransferID != first.TransferID {
		t.Fatalf("pinned=%+v,%v", state, err)
	}
	states, err := listStates(dir)
	if err != nil || len(states) != 2 {
		t.Fatalf("history=%+v,%v", states, err)
	}
	second.StartedAt = first.StartedAt
	dir = t.TempDir()
	writeState(dir, second)
	writeState(dir, first)
	state, err = readState(dir, "12345")
	if err != nil || state.TransferID != second.TransferID {
		t.Fatalf("tie=%+v,%v", state, err)
	}
}

func TestStateLegacyMigrationRetainsNewerSnapshotAndDeduplicates(t *testing.T) {
	dir := t.TempDir()
	state := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
	state.UpdatedAt = state.StartedAt
	rawState(t, dir, state.Code, state)
	migrated, err := readState(dir, state.TransferID)
	if err != nil || migrated.TransferID != state.TransferID {
		t.Fatalf("legacy ID lookup=%+v,%v", migrated, err)
	}
	if _, err = os.Stat(filepath.Join(dir, state.TransferID+".json")); err != nil {
		t.Fatal("legacy snapshot not migrated:", err)
	}
	state.Phase = phaseSending
	state.Acknowledged = 50
	if err = writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	states, err := listStates(dir)
	if err != nil || len(states) != 1 || states[0].Acknowledged != 50 {
		t.Fatalf("duplicate/stale=%+v,%v", states, err)
	}
	// An old holder can still update its code path during an upgrade.
	current := states[0]
	current.Acknowledged = 75
	current.UpdatedAt = current.UpdatedAt.Add(time.Second)
	rawState(t, dir, current.Code, current)
	migrated, err = readState(dir, current.TransferID)
	if err != nil || migrated.Acknowledged != 75 {
		t.Fatalf("live legacy update=%+v,%v", migrated, err)
	}
}

func TestStateRefusesIdentityChanges(t *testing.T) {
	dir := t.TempDir()
	state := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	for name, modify := range map[string]func(*transferState){"file": func(s *transferState) { s.Filename = "other.bin" }, "size": func(s *transferState) { s.Size++ }, "code": func(s *transferState) { s.Code = "54321" }, "holder": func(s *transferState) { s.PID++ }} {
		t.Run(name, func(t *testing.T) {
			changed := state
			modify(&changed)
			if err := writeState(dir, changed); err == nil {
				t.Fatal("rebound immutable identity")
			}
		})
	}
}

func TestStateRejectsInvalidAndInconsistentRecords(t *testing.T) {
	for name, modify := range map[string]func(*transferState){"id": func(s *transferState) { s.TransferID = "../../escape" }, "filename": func(s *transferState) { s.Filename = "../escape" },
		"controlFilename": func(s *transferState) { s.Filename = "escape\n.bin" },
		"longFilename":    func(s *transferState) { s.Filename = strings.Repeat("x", 256) },
		"retry":           func(s *transferState) { s.Retry = "retry_whatever" }, "windowsFilename": func(s *transferState) { s.Filename = `a\escape` }, "phase": func(s *transferState) { s.Phase = "unknown" }, "progress": func(s *transferState) { s.Acknowledged = 101 }, "verified": func(s *transferState) { s.Phase = phaseVerified }, "version": func(s *transferState) { s.Version = 2 }} {
		t.Run(name, func(t *testing.T) {
			state := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
			modify(&state)
			if err := writeState(t.TempDir(), state); err == nil {
				t.Fatal("accepted invalid state")
			}
		})
	}
	dir := t.TempDir()
	state := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
	state.UpdatedAt = state.StartedAt
	rawState(t, dir, "54321", state)
	if _, err := listStates(dir); err == nil {
		t.Fatal("accepted filename-key mismatch")
	}
	if _, err := readState(dir, "../outside"); err == nil {
		t.Fatal("accepted unsafe key")
	}
}

func TestStateAtomicConcurrentWrites(t *testing.T) {
	dir := t.TempDir()
	state := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
	var workers sync.WaitGroup
	failures := make(chan error, 40)
	for i := 0; i < 40; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); failures <- writeState(dir, state) }()
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	got, err := readState(dir, state.TransferID)
	if err != nil || got.TransferID != state.TransferID {
		t.Fatalf("atomic snapshot=%+v,%v", got, err)
	}
}

func TestStatePruningCannotRemoveReusedCodeOrOutsideLog(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "send-123456789abc.log")
	os.WriteFile(outside, []byte("keep"), 0600)
	first := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
	first.StartedAt = time.Now().Add(-48 * time.Hour)
	first.UpdatedAt = first.StartedAt
	first.Phase = phaseVerified
	first.Acknowledged = 100
	first.Log = outside
	second := identityFixture("bO6Ww6lyA10XmqHEgQYHyA", "12345")
	second.UpdatedAt = second.StartedAt
	rawState(t, dir, first.TransferID, first)
	rawState(t, dir, second.Code, second)
	pruneStates(dir, time.Now())
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("pruned outside log:", err)
	}
	if got, err := readState(dir, second.Code); err != nil || got.TransferID != second.TransferID {
		t.Fatalf("reused code removed=%+v,%v", got, err)
	}
	if _, err := readState(dir, first.TransferID); !os.IsNotExist(err) {
		t.Fatalf("old history not pruned: %v", err)
	}
}

func TestHolderFailureSidecarPreservesTypedGuidance(t *testing.T) {
	log := filepath.Join(t.TempDir(), "send-123456789abc.log")
	t.Setenv("CD_HOLDER_LOG", log)
	recordHolderFailure(NewFailure(failureBusy, "completely different wording", retrySameRequest))
	err := readHolderFailure(log)
	if classifyFailure(err) != failureBusy || failureGuidance(err) != retrySameRequest || err.Error() != "completely different wording" {
		t.Fatalf("sidecar changed contract: %v", err)
	}
	info, err := os.Stat(log + ".failure.json")
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("sidecar permissions: %v,%v", info, err)
	}
	os.WriteFile(log+".failure.json", []byte(`{"version":1}`), 0600)
	if classifyFailure(readHolderFailure(log)) != failureProtocol {
		t.Fatal("corrupt sidecar was accepted")
	}
}

func TestStateNeverRegressesVerifiedHistory(t *testing.T) {
	dir := t.TempDir()
	state := identityFixture("aO6Ww6lyA10XmqHEgQYHyA", "12345")
	state.Phase = phaseVerified
	state.Acknowledged = state.Size
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	state.Phase = phaseSending
	if err := writeState(dir, state); err == nil {
		t.Fatal("reopened terminal transfer")
	}
	state.Phase = phaseVerified
	state.Acknowledged = 0
	if err := writeState(dir, state); err == nil {
		t.Fatal("regressed progress")
	}
}
