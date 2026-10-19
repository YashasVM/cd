package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeviceAttemptDoesNotRetryCapabilityPersistenceFailure(t *testing.T) {
	source, _ := deviceSource(t, 128)
	output := deviceTestOutput(t)
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	want := []byte("leave existing state alone")
	if err := os.WriteFile(blocker, want, 0600); err != nil {
		t.Fatal(err)
	}
	// A regular-file ancestor fails even when tests run as root. Keep a missing
	// directory below it so both native storage implementations return PathError.
	t.Setenv("CD_STATE_DIR", filepath.Join(blocker, "state"))
	t.Setenv("CD_RELAY_URL", "ws://127.0.0.1:1/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "http://127.0.0.1:1")

	connectCalls := 0
	request := sendRequest{files: []string{source}, jsonOutput: true}
	request.deviceConnect = func(context.Context, invitation, []byte, int64, readyOutput, string) (*resumeSession, error) {
		connectCalls++
		return nil, errors.New("connection attempted before capability persistence")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err, receivedID := sendDeviceAttempt(ctx, request, make(chan string))
	if connectCalls != 0 {
		t.Fatalf("attempted %d connections without persisting the capability", connectCalls)
	}
	if receivedID != "" {
		t.Fatalf("failed persistence accepted a receipt for %q", receivedID)
	}
	if ctx.Err() != nil {
		t.Fatalf("storage failure waited for the attempt deadline: %v", ctx.Err())
	}
	pathErr, ok := err.(*os.PathError)
	if !ok {
		t.Fatalf("want the raw capability storage PathError, got %T: %v", err, err)
	}
	if pathErr.Path != blocker && !strings.HasPrefix(pathErr.Path, blocker+string(os.PathSeparator)) {
		t.Fatalf("failure came from %q rather than blocked capability storage %q", pathErr.Path, blocker)
	}
	// Exercise the same decision runDeviceSend makes with the actual attempt
	// error, not a synthetic Failure with an explicit retry policy.
	if retryDeviceTransfer(err) {
		t.Fatalf("device command would retry permanent capability persistence failure: %v", err)
	}
	if data := deviceOutputBytes(t, output); len(data) != 0 {
		t.Fatalf("failed persistence published transfer output: %s", data)
	}
	if got, err := os.ReadFile(blocker); err != nil || !bytes.Equal(got, want) {
		t.Fatalf("failed persistence changed the existing file: %q, %v", got, err)
	}
}
