package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Exercise independent CLI processes, rather than the request journal's
// implementation, to prove its lock spans holder creation and ready persistence.
func TestRequestRetryConcurrentProcessesShareOneHolder(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "cdx")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, output)
	}
	relay := newFakeRelay(t, "11111")
	relay.join = make(chan map[string]string, 16)
	stateDirectory := t.TempDir()
	t.Setenv("CD_STATE_DIR", stateDirectory)
	file := filepath.Join(t.TempDir(), "payload.txt")
	writeTestFile(t, file, []byte("original content"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	type result struct {
		ready      readyOutput
		err        error
		diagnostic string
	}
	results := make([]result, 4)
	var group sync.WaitGroup
	for i := range results {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			command := exec.CommandContext(ctx, binary, "send", "--json", "--request-id", "retry-concurrent", file)
			var stdout, stderr bytes.Buffer
			command.Stdout, command.Stderr = &stdout, &stderr
			results[i].err = command.Run()
			results[i].diagnostic = stderr.String() + stdout.String()
			if results[i].err == nil {
				results[i].err = json.Unmarshal(stdout.Bytes(), &results[i].ready)
			}
		}(i)
	}
	group.Wait()
	states, err := listStates(stateDirectory)
	if err != nil {
		t.Fatal(err)
	}
	// Always clean up holders, including when a regression creates duplicates.
	for _, state := range states {
		if process, err := os.FindProcess(state.PID); err == nil {
			t.Cleanup(func() { _ = process.Kill() })
		}
	}
	for i, result := range results {
		if result.err != nil {
			t.Fatalf("request %d: %v: %s", i, result.err, result.diagnostic)
		}
		if (result.ready.Code != "11111" && result.ready.Code != "") || result.ready.URL != results[0].ready.URL || result.ready.TransferID != results[0].ready.TransferID {
			t.Fatalf("request %d created a different transfer: %#v", i, result.ready)
		}
	}
	if len(states) != 1 || !processAlive(states[0].PID) || states[0].TransferID != results[0].ready.TransferID {
		t.Fatalf("expected one live holder, got %#v", states)
	}
	if len(relay.join) != 1 {
		t.Fatalf("expected one relay admission, got %d", len(relay.join))
	}
	// The fake relay has no directory GET endpoint, so safe replay may clear
	// the unverifiable code while retaining the original private capability.
	t.Logf("4 concurrent requests: one transfer %s, one holder PID %d", states[0].TransferID, states[0].PID)

	// Same-size replacement defeats metadata-only fingerprints.
	writeTestFile(t, file, []byte("modified content"))
	command := exec.CommandContext(ctx, binary, "send", "--json", "--request-id", "retry-concurrent", file)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err == nil {
		t.Fatal("same request accepted changed bytes")
	}
	var failure struct {
		Error struct {
			Kind string `json:"kind"`
		} `json:"error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &failure); err != nil || failure.Error.Kind != "request_conflict" {
		t.Fatalf("changed input failure = %s: %v; %s", stdout.Bytes(), err, stderr.String())
	}
	if current, err := listStates(stateDirectory); err != nil || len(current) != 1 {
		t.Fatalf("conflict started another holder: %#v, %v", current, err)
	}
}

func TestReusedShareCodePreservesIndependentTransferHistory(t *testing.T) {
	dir := t.TempDir()
	old := transferState{Version: 1, TransferID: "aO6Ww6lyA10XmqHEgQYHyA", Code: "11111", Phase: phaseVerified, Filename: "old.txt", PID: os.Getpid(), StartedAt: time.Now().Add(-time.Hour)}
	latest := transferState{Version: 1, TransferID: "bO6Ww6lyA10XmqHEgQYHyA", Code: old.Code, Phase: phaseWaiting, Filename: "new.txt", PID: os.Getpid(), StartedAt: time.Now()}
	if err := writeState(dir, old); err != nil {
		t.Fatal(err)
	}
	if err := writeState(dir, latest); err != nil {
		t.Fatal(err)
	}
	states, err := listStates(dir)
	if err != nil || len(states) != 2 {
		t.Fatalf("code reuse lost history: %#v, %v", states, err)
	}
	for key, want := range map[string]string{old.TransferID: old.Filename, latest.TransferID: latest.Filename, old.Code: latest.Filename} {
		state, err := readState(dir, key)
		if err != nil || state.Filename != want {
			t.Fatalf("lookup %s = %#v, %v; want %s", key, state, err, want)
		}
	}
}
