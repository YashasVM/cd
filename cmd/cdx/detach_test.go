package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestShouldDetachDefaultsToBackgroundWithoutATerminal(t *testing.T) {
	tests := []struct {
		name     string
		request  sendRequest
		terminal bool
		want     bool
	}{
		{"terminal", sendRequest{}, true, false},
		{"pipe or agent", sendRequest{}, false, true},
		{"--detach in a terminal", sendRequest{detach: true}, true, true},
		{"--wait without a terminal", sendRequest{wait: true}, false, false},
	}
	for _, test := range tests {
		if got := shouldDetach(test.request, test.terminal); got != test.want {
			t.Fatalf("%s: shouldDetach = %v, want %v", test.name, got, test.want)
		}
	}
}

func TestParseSendArgsDetachAndWaitFlags(t *testing.T) {
	request, err := parseSendArgs([]string{"--detach", "file.bin"})
	if err != nil || !request.detach {
		t.Fatalf("--detach = %#v, %v", request, err)
	}
	request, err = parseSendArgs([]string{"file.bin", "--wait"})
	if err != nil || !request.wait {
		t.Fatalf("--wait = %#v, %v", request, err)
	}
	if _, err := parseSendArgs([]string{"--detach", "--wait", "file.bin"}); err == nil {
		t.Fatal("accepted --detach with --wait")
	}
}

func TestStateKeyFromInputAcceptsCodesIDsAndLinks(t *testing.T) {
	for input, want := range map[string]string{
		"48291":                  "48291",
		" 4829 ":                 "4829",
		"aO6Ww6lyA10XmqHEgQYHyA": "aO6Ww6lyA10XmqHEgQYHyA",
		"https://cd.yash0.in/s/aO6Ww6lyA10XmqHEgQYHyA#v1.key": "aO6Ww6lyA10XmqHEgQYHyA",
	} {
		if got, err := stateKeyFromInput(input); err != nil || got != want {
			t.Fatalf("stateKeyFromInput(%q) = %q, %v", input, got, err)
		}
	}
	for _, input := range []string{"", "123", "../../etc/passwd", "48291.json"} {
		if _, err := stateKeyFromInput(input); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}

func TestStateRoundTripAndLinkModeKey(t *testing.T) {
	dir := t.TempDir()
	coded := transferState{Version: 1, Code: "48291", TransferID: "aO6Ww6lyA10XmqHEgQYHyA", Filename: "a.bin", Phase: phaseWaiting, PID: os.Getpid()}
	if err := writeState(dir, coded); err != nil {
		t.Fatal(err)
	}
	read, err := readState(dir, "48291")
	if err != nil || read.Filename != "a.bin" || read.UpdatedAt.IsZero() {
		t.Fatalf("readState = %#v, %v", read, err)
	}
	linked := transferState{Version: 1, TransferID: "bO6Ww6lyA10XmqHEgQYHyA", Phase: phaseWaiting}
	if err := writeState(dir, linked); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "bO6Ww6lyA10XmqHEgQYHyA.json")); err != nil {
		t.Fatalf("link-mode state is not keyed by transfer ID: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "48291.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode = %v, %v", info.Mode().Perm(), err)
	}
}

func deadPID(t *testing.T) int {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^$")
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	return command.Process.Pid
}

func TestEffectiveStateReportsADeadHolderAsFailed(t *testing.T) {
	dir := t.TempDir()
	state := transferState{Version: 1, Code: "48291", Phase: phaseSending, PID: deadPID(t)}
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	if got := effectiveState(dir, state); got.Phase != phaseFailed || got.Error == "" {
		t.Fatalf("dead holder state = %#v", got)
	}
	// A holder that wrote its final state before exiting is not a failure.
	state.Phase = phaseVerified
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	stale := state
	stale.Phase = phaseSending
	if got := effectiveState(dir, stale); got.Phase != phaseVerified {
		t.Fatalf("finished holder state = %#v", got)
	}
	live := transferState{Code: "1234", Phase: phaseWaiting, PID: os.Getpid()}
	if got := effectiveState(dir, live); got.Phase != phaseWaiting {
		t.Fatalf("live holder state = %#v", got)
	}
}

func TestPruneStatesKeepsRecentTransfers(t *testing.T) {
	dir := t.TempDir()
	for _, state := range []transferState{
		{Code: "1111", Phase: phaseVerified},
		{Code: "2222", Phase: phaseSending},
	} {
		if err := writeState(dir, state); err != nil {
			t.Fatal(err)
		}
	}
	pruneStates(dir, time.Now().Add(time.Hour))
	if states, _ := listStates(dir); len(states) != 2 {
		t.Fatalf("pruned recent transfers: %d left", len(states))
	}
	pruneStates(dir, time.Now().Add(4*time.Hour))
	if states, _ := listStates(dir); len(states) != 1 || states[0].Code != "1111" {
		t.Fatalf("after stale prune = %#v", states)
	}
	pruneStates(dir, time.Now().Add(25*time.Hour))
	if states, _ := listStates(dir); len(states) != 0 {
		t.Fatalf("after finished prune = %#v", states)
	}
}

func TestHolderFailureReturnsTheLastErrorLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "send.log")
	if err := os.WriteFile(path, []byte("sharing a.bin\ncdx: first\nnoise\ncdx: CD relay did not answer\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := holderFailure(path); got != "cdx: CD relay did not answer" {
		t.Fatalf("holderFailure = %q", got)
	}
}
