//go:build !windows

package main

import (
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestOpenSharedFileRejectsFifoWithoutBlocking(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pipe")
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Skipf("fifo unavailable: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		_, _, err := openSharedFile(path)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Fatalf("fifo error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("openSharedFile blocked on a FIFO")
	}
}
