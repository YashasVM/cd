package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"testing"
	"time"
)

// Diagnostic only: opt in explicitly. This exercises the real v2 transfer
// functions over authenticated local WebSockets, not the Wrangler relay. The
// local sender has a server-side socket, so its framing differs from relay send.
func TestProfileV2LocalTransfer(t *testing.T) {
	if os.Getenv("CD_PROFILE_V2_LOCAL") != "1" {
		t.Skip("set CD_PROFILE_V2_LOCAL=1 for the local profiling diagnostic")
	}
	if runtime.GOOS != "linux" {
		t.Skip("same-filesystem profiling driver is Linux-only")
	}
	const size = 64 * 1024 * 1024
	const transfers = 16
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(cwd, ".profile-v2-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(work) })
	// Keep source, destination, and the existing helpers' temporary state on
	// this checkout's filesystem rather than silently switching to /tmp.
	t.Setenv("TMPDIR", work)
	t.Setenv("CD_DIRECT", "0")
	h := newDeviceTransferHarness(t)
	deviceTransferEnvironment(t, h.server.URL)
	deviceTestOutput(t)
	source := filepath.Join(work, "source.bin")
	file, err := os.OpenFile(source, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	block := make([]byte, 1024*1024)
	for index := range block {
		block[index] = byte((index*31 + index/251) % 256)
	}
	for written := 0; written < size; written += len(block) {
		if _, err = file.Write(block); err != nil {
			file.Close()
			t.Fatal(err)
		}
	}
	if err = file.Sync(); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	want := profileV2FileDigest(t, source)
	directory := t.TempDir()
	destination := filepath.Join(directory, "received.bin")
	started := time.Now()
	for iteration := 0; iteration < transfers; iteration++ {
		profileV2LocalTransfer(t, h, source, destination)
		info, err := os.Stat(destination)
		if err != nil || info.Size() != size {
			t.Fatalf("iteration %d destination size: %v, %v", iteration, info, err)
		}
		if got := profileV2FileDigest(t, destination); got != want {
			t.Fatalf("iteration %d destination SHA-256 differs", iteration)
		}
		entries, err := os.ReadDir(directory)
		if err != nil || len(entries) != 1 || entries[0].Name() != "received.bin" {
			t.Fatalf("iteration %d retained receive state: %v, %v", iteration, entries, err)
		}
		if err := os.Remove(destination); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("authenticated local v2 profile: %d transfers x %d bytes, %.3fs including streamed output verification; not Wrangler end-to-end", transfers, size, time.Since(started).Seconds())
}

func profileV2LocalTransfer(t *testing.T, h *deviceTransferHarness, source, destination string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	received := make(chan error, 1)
	startedReceiver := false
	var transferID string
	request := sendRequest{files: []string{source}, jsonOutput: true}
	request.deviceConnect = func(callCtx context.Context, invite invitation, _ []byte, expiry int64, ready readyOutput, _ string) (*resumeSession, error) {
		transferID = invite.encodedID()
		local := h.arm(invite, expiry)
		startedReceiver = true
		go func() {
			pprof.Do(callCtx, pprof.Labels("role", "receiver"), func(receiveCtx context.Context) {
				received <- receiveResumable(receiveCtx, receiveRequest{resume: true, code: ready.URL, out: destination, jsonOutput: true})
			})
		}()
		select {
		case session := <-local.Sessions:
			return session, nil
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
	}
	var sendErr error
	pprof.Do(ctx, pprof.Labels("role", "sender"), func(sendCtx context.Context) {
		sendErr = sendResumable(sendCtx, request)
	})
	if sendErr != nil {
		cancel()
	}
	var receiveErr error
	if startedReceiver {
		receiveErr = waitDeviceResult(t, ctx, received)
	}
	if sendErr != nil || receiveErr != nil {
		t.Fatalf("profile transfer failed: sender=%v receiver=%v", sendErr, receiveErr)
	}
	capability, err := resumeCapabilityPath(transferID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(capability); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("verified sender retained private capability")
	}
}

func profileV2FileDigest(t *testing.T, path string) [sha256.Size]byte {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		t.Fatal(err)
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return digest
}
