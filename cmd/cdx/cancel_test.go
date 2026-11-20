package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"testing"
	"time"
)

// TestCancelHelperProcess blocks until it receives a shutdown signal. It is
// re-executed by the cancel tests as a stand-in for a live background holder.
func TestCancelHelperProcess(t *testing.T) {
	if os.Getenv("CD_CANCEL_HELPER") != "1" {
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	<-ctx.Done()
}

// captureRun runs fn with stdout and stderr redirected to pipes and returns
// the exit status alongside both captured streams.
func captureRun(t *testing.T, fn func() int) (status int, stdout, stderr string) {
	t.Helper()
	originalStdout, originalStderr := os.Stdout, os.Stderr
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stderrReader, stderrWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout, os.Stderr = stdoutWriter, stderrWriter
	status = fn()
	stdoutWriter.Close()
	stderrWriter.Close()
	stdoutBytes, _ := io.ReadAll(stdoutReader)
	stderrBytes, _ := io.ReadAll(stderrReader)
	stdoutReader.Close()
	stderrReader.Close()
	os.Stdout, os.Stderr = originalStdout, originalStderr
	return status, string(stdoutBytes), string(stderrBytes)
}

func TestCancelTerminatesLiveTransfer(t *testing.T) {
	helper := exec.Command(os.Args[0], "-test.run=TestCancelHelperProcess")
	helper.Env = append(os.Environ(), "CD_CANCEL_HELPER=1")
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	// Reap the helper as soon as it exits so processAlive stops reporting it
	// (a direct child stays "alive" as a zombie until Wait is called).
	reaped := make(chan struct{})
	go func() {
		_ = helper.Wait()
		close(reaped)
	}()
	t.Cleanup(func() {
		_ = helper.Process.Kill()
		<-reaped
	})

	dir := t.TempDir()
	state := transferState{
		Version:      1,
		Code:         "48291",
		TransferID:   "aO6Ww6lyA10XmqHEgQYHyA",
		Filename:     "a.bin",
		Size:         10,
		Acknowledged: 5,
		Phase:        phaseSending,
		PID:          helper.Process.Pid,
		StartedAt:    time.Now().UTC(),
	}
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CD_STATE_DIR", dir)

	status, _, stderrOut := captureRun(t, func() int { return runCancel([]string{"48291"}) })
	if status != 0 {
		t.Fatalf("cancel status = %d, stderr = %q", status, stderrOut)
	}
	if processAlive(helper.Process.Pid) {
		t.Fatal("holder still alive after cancel")
	}
	fresh, err := readState(dir, "aO6Ww6lyA10XmqHEgQYHyA")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Phase != phaseFailed || fresh.ErrorKind != failureCanceled || fresh.Error != "transfer canceled" {
		t.Fatalf("canceled state = %#v", fresh)
	}
}

func TestCancelAlreadyFinished(t *testing.T) {
	dir := t.TempDir()
	state := transferState{
		Version:      1,
		Code:         "48291",
		TransferID:   "aO6Ww6lyA10XmqHEgQYHyA",
		Filename:     "a.bin",
		Size:         10,
		Acknowledged: 10,
		Phase:        phaseVerified,
		PID:          os.Getpid(),
		StartedAt:    time.Now().UTC(),
	}
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CD_STATE_DIR", dir)

	status, _, stderrOut := captureRun(t, func() int { return runCancel([]string{"48291"}) })
	if status != 0 {
		t.Fatalf("cancel status = %d", status)
	}
	if !strings.Contains(stderrOut, "already verified") {
		t.Fatalf("stderr = %q", stderrOut)
	}
	fresh, err := readState(dir, "aO6Ww6lyA10XmqHEgQYHyA")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Phase != phaseVerified {
		t.Fatalf("finished state changed = %#v", fresh)
	}
}

func TestCancelAlreadyFinishedJSON(t *testing.T) {
	dir := t.TempDir()
	state := transferState{
		Version:      1,
		Code:         "48291",
		TransferID:   "aO6Ww6lyA10XmqHEgQYHyA",
		Filename:     "a.bin",
		Size:         10,
		Acknowledged: 10,
		Phase:        phaseVerified,
		PID:          os.Getpid(),
		StartedAt:    time.Now().UTC(),
	}
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CD_STATE_DIR", dir)

	status, stdoutOut, _ := captureRun(t, func() int { return runCancel([]string{"--json", "48291"}) })
	if status != 0 {
		t.Fatalf("cancel status = %d", status)
	}
	if !strings.Contains(stdoutOut, `"phase":"verified"`) {
		t.Fatalf("stdout = %q", stdoutOut)
	}
}

func TestCancelMissingTransfer(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CD_STATE_DIR", dir)
	status, _, _ := captureRun(t, func() int { return runCancel([]string{"48291"}) })
	if status != 1 {
		t.Fatalf("cancel status = %d, want 1", status)
	}
}

func TestCancelBadArgs(t *testing.T) {
	for _, args := range [][]string{
		{},
		{"--timeout", "5m", "48291"},
		{"48291", "1234"},
	} {
		status, _, _ := captureRun(t, func() int { return runCancel(args) })
		if status != 2 {
			t.Fatalf("runCancel(%v) = %d, want 2", args, status)
		}
	}
}
