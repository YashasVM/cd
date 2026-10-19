package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/YashasVM/cd/internal/privatefs"
)

// Exercise the actual receiver after acceptance: its checkpoint updates,
// publication, and cancellation must all retain the same directory handle.
func TestResumePinsDirectoryDuringReceive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows os.OpenRoot blocks the directory rename; covered by native privatefs handle tests")
	}
	for _, cancelTransfer := range []bool{false, true} {
		label := "complete"
		if cancelTransfer {
			label = "cancel"
		}
		t.Run(label, func(t *testing.T) {
			dir, moved, replacement, replace := resumeReplacedDirectory(t)
			h := newDeviceTransferHarness(t)
			deviceTransferEnvironment(t, h.server.URL)
			deviceTestOutput(t)
			invite, err := newInvitation(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			expiry := time.Now().Add(time.Hour).UnixMilli()
			local := h.arm(invite, expiry)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			done := make(chan error, 1)
			go func() {
				done <- receiveResumable(ctx, receiveRequest{code: h.server.URL + "/s/" + invite.encodedID() + "#v2." + invite.encodedKey(), out: dir, jsonOutput: true})
			}()
			finished := false
			defer func() {
				cancel()
				if !finished {
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Error("receiver did not stop")
					}
				}
			}()
			var session *resumeSession
			select {
			case session = <-local.Sessions:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			defer session.close()
			payload := []byte("REMOTE")
			digest := sha256.Sum256(payload)
			whole := hex.EncodeToString(digest[:])
			offer, _ := json.Marshal(resumeOffer{Name: "payload.bin", Size: strconv.Itoa(len(payload)), ChunkSize: chunkSize, WholeSHA256: whole, ExpiresAt: expiry})
			if err = session.send(kindOffer, offer); err != nil {
				t.Fatal(err)
			}
			if kind, _, err := session.next(); err != nil || kind != kindAccept {
				t.Fatalf("accept = %v, %v", kind, err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 2 {
				t.Fatalf("retained stage/checkpoint = %v, %v", entries, err)
			}
			replace()
			for _, entry := range entries {
				if err = os.WriteFile(filepath.Join(replacement, entry.Name()), []byte("LOCAL"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if cancelTransfer {
				cancel()
			} else {
				if err = session.send(kindChunk, payload); err != nil {
					t.Fatal(err)
				}
				if kind, _, err := session.next(); err != nil || kind != kindAck {
					t.Fatalf("ack = %v, %v", kind, err)
				}
				if err = session.send(kindEnd, resumeEnd(uint64(len(payload)), whole)); err != nil {
					t.Fatal(err)
				}
				if kind, _, err := session.next(); err != nil || kind != kindComplete {
					t.Fatalf("complete = %v, %v", kind, err)
				}
				if err = session.terminal(false); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err = <-done:
				finished = true
			case <-time.After(5 * time.Second):
				t.Fatal("receiver did not finish")
			}
			if (err != nil) != cancelTransfer {
				t.Fatalf("receive = %v; cancellation = %v", err, cancelTransfer)
			}
			for _, entry := range entries {
				if got, err := os.ReadFile(filepath.Join(replacement, entry.Name())); err != nil || string(got) != "LOCAL" {
					t.Errorf("replacement sentinel = %q, %v", got, err)
				}
				if _, err := os.Lstat(filepath.Join(moved, entry.Name())); !os.IsNotExist(err) {
					t.Errorf("retained stage/checkpoint after completion: %v", err)
				}
			}
			if !cancelTransfer {
				if got, err := os.ReadFile(filepath.Join(moved, "payload.bin")); err != nil || string(got) != string(payload) {
					t.Errorf("pinned publication = %q, %v", got, err)
				}
			}
			if _, err := os.Lstat(filepath.Join(replacement, "payload.bin")); !os.IsNotExist(err) {
				t.Errorf("published in replacement directory: %v", err)
			}
		})
	}
}

// Both directories are disposable fixtures. No path outside t.TempDir is used.
func resumeReplacedDirectory(t *testing.T) (dir, moved, replacement string, replace func()) {
	t.Helper()
	parent := t.TempDir()
	dir, moved, replacement = filepath.Join(parent, "chosen"), filepath.Join(parent, "moved"), filepath.Join(parent, "replacement")
	for _, path := range []string{dir, replacement} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	replace = func() {
		t.Helper()
		if err := os.Rename(dir, moved); err != nil {
			// os.OpenRoot on Windows holds a non-delete-shared directory
			// handle. Preventing the rename also prevents this attack.
			if runtime.GOOS == "windows" {
				t.Skipf("Windows pins the selected directory by blocking its rename: %v", err)
			}
			t.Fatal(err)
		}
		if err := os.Symlink(replacement, dir); err != nil {
			t.Skipf("directory symlink is unavailable: %v", err)
		}
	}
	return
}

func TestResumePinsDirectoryBeforeStageCreation(t *testing.T) {
	dir, moved, replacement, replace := resumeReplacedDirectory(t)
	destination, err := resumeDest("payload.bin", dir, "AAAAAAAAAAAAAAAAAAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.root.Close()
	replace()
	stage, name, err := privatefs.CreateTempRoot(destination.root, ".cd-stage-*.part")
	if err != nil {
		t.Fatal(err)
	}
	defer stage.Close()
	if _, err = stage.WriteString("REMOTE"); err != nil {
		t.Fatal(err)
	}
	checkpoint := ResumeCheckpoint{StagingID: name, Destination: destination.final}
	if err = resumeAtomicJSONRoot(destination.root, destination.checkpointName, checkpoint); err != nil {
		t.Fatal(err)
	}
	if err = destination.publish(stage, name); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(moved, "payload.bin")); err != nil || string(got) != "REMOTE" {
		t.Errorf("pinned publication = %q, %v", got, err)
	}
	if entries, err := os.ReadDir(replacement); err != nil || len(entries) != 0 {
		t.Errorf("replacement directory was modified: %v, %v", entries, err)
	}
}

func TestResumePinsDirectoryAfterStageCreation(t *testing.T) {
	dir, moved, replacement, replace := resumeReplacedDirectory(t)
	checkpoint, master, path := checkpointFixture(t, dir)
	destination, err := resumeDest("payload.bin", dir, checkpoint.RootID)
	if err != nil {
		t.Fatal(err)
	}
	defer destination.root.Close()
	if err := resumeAtomicJSONRoot(destination.root, destination.checkpointName, checkpoint); err != nil {
		t.Fatal(err)
	}
	replace()
	for _, name := range []string{checkpoint.StagingID, filepath.Base(path)} {
		if err := os.WriteFile(filepath.Join(replacement, name), []byte("LOCAL"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := resumeAtomicJSONRoot(destination.root, destination.checkpointName, checkpoint); err != nil {
		t.Fatal(err)
	}
	var stored ResumeCheckpoint
	if err := resumeReadJSONRoot(destination.root, destination.checkpointName, &stored); err != nil {
		t.Fatal(err)
	}
	if err := verifyResumeCheckpoint(stored, master, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	stage, err := resumeStage(destination.root, stored)
	if err != nil {
		t.Fatal(err)
	}
	stage.Close()
	resumeRemove(destination.root, checkpoint, destination.checkpointName)
	for _, name := range []string{checkpoint.StagingID, filepath.Base(path)} {
		if got, err := os.ReadFile(filepath.Join(replacement, name)); err != nil || string(got) != "LOCAL" {
			t.Errorf("replacement file %q = %q, %v", name, got, err)
		}
		if _, err := os.Lstat(filepath.Join(moved, name)); !os.IsNotExist(err) {
			t.Errorf("pinned cleanup left %q: %v", name, err)
		}
	}
}

func TestResumePinsDirectoryPublicationDoesNotOverwrite(t *testing.T) {
	for _, existing := range []string{"regular", "symlink", "same stage", "replaced stage"} {
		t.Run(existing, func(t *testing.T) {
			dir := t.TempDir()
			destination, err := resumeDest("payload.bin", dir, "AAAAAAAAAAAAAAAAAAAAAA")
			if err != nil {
				t.Fatal(err)
			}
			defer destination.root.Close()
			stage, name, err := privatefs.CreateTempRoot(destination.root, ".cd-stage-*.part")
			if err != nil {
				t.Fatal(err)
			}
			defer stage.Close()
			if _, err = stage.WriteString("REMOTE"); err != nil {
				t.Fatal(err)
			}
			switch existing {
			case "regular":
				err = destination.root.WriteFile(destination.name, []byte("LOCAL"), 0600)
			case "symlink":
				if err = destination.root.WriteFile("target", []byte("LOCAL"), 0600); err != nil {
					t.Fatal(err)
				}
				if err = destination.root.Symlink("target", destination.name); err != nil {
					t.Skipf("symlink is unavailable: %v", err)
				}
			case "same stage":
				err = destination.root.Link(name, destination.name)
			case "replaced stage":
				if err = destination.root.Rename(name, "original-stage"); err != nil {
					t.Fatal(err)
				}
				err = destination.root.WriteFile(name, []byte("LOCAL"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			err = destination.publish(stage, name)
			if existing == "same stage" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("publication accepted a different file")
			}
			if existing == "replaced stage" {
				if _, err = destination.root.Lstat(destination.name); !os.IsNotExist(err) {
					t.Fatalf("published replacement staging: %v", err)
				}
			} else if got, err := destination.root.ReadFile(destination.name); err != nil || string(got) != "LOCAL" {
				t.Fatalf("changed existing destination: %q, %v", got, err)
			}
		})
	}
}
