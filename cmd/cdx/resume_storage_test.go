package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/YashasVM/cd/internal/privatefs"
)

func checkpointFixture(t *testing.T, dir string) (ResumeCheckpoint, []byte, string) {
	t.Helper()
	master := make([]byte, 32)
	rand.Read(master)
	stage, err := privatefs.CreateTemp(dir, ".cd-stage-*.part")
	if err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, chunkSize)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	stage.Write(payload)
	stage.Sync()
	stage.Close()
	digest := sha256.Sum256(payload)
	nonce := make([]byte, 32)
	rand.Read(nonce)
	checkpoint := ResumeCheckpoint{Version: 2, Role: "receiver", RootID: "aO6Ww6lyA10XmqHEgQYHyA", Filename: "payload.bin", Size: 2 * chunkSize, ChunkSize: chunkSize, WholeSHA256: hex.EncodeToString(digest[:]), Offset: chunkSize, PrefixSHA256: hex.EncodeToString(digest[:]), StagingID: filepath.Base(stage.Name()), Destination: filepath.Join(dir, "payload.bin"), ExpiresAt: time.Now().Add(time.Hour).UnixMilli(), PriorSessionNonce: resumeEncoded(nonce)}
	if err = signResumeCheckpoint(&checkpoint, master); err != nil {
		t.Fatal(err)
	}
	return checkpoint, master, filepath.Join(dir, ".cd-"+checkpoint.RootID+".checkpoint.json")
}
func TestResumeCheckpointDurablePrefixAndTailTruncation(t *testing.T) {
	dir := t.TempDir()
	root, rootErr := os.OpenRoot(dir)
	if rootErr != nil {
		t.Fatal(rootErr)
	}
	defer root.Close()
	checkpoint, master, path := checkpointFixture(t, dir)
	if err := resumeAtomicJSON(path, checkpoint); err != nil {
		t.Fatal(err)
	}
	var stored ResumeCheckpoint
	if err := resumeReadJSON(path, &stored); err != nil {
		t.Fatal(err)
	}
	if err := verifyResumeCheckpoint(stored, master, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	stagePath := filepath.Join(dir, checkpoint.StagingID)
	stage, _ := os.OpenFile(stagePath, os.O_APPEND|os.O_WRONLY, 0600)
	stage.Write([]byte("uncommitted tail"))
	stage.Close()
	resumed, err := resumeStage(root, stored)
	if err != nil {
		t.Fatal(err)
	}
	defer resumed.Close()
	info, _ := resumed.Stat()
	if info.Size() != chunkSize {
		t.Fatal("uncommitted tail survived:", info.Size())
	}
	position, _ := resumed.Seek(0, 1)
	if position != chunkSize {
		t.Fatal("prefix wasn't skipped:", position)
	}
}
func TestResumeRejectsTamperedCheckpointAndStaging(t *testing.T) {
	dir := t.TempDir()
	root, rootErr := os.OpenRoot(dir)
	if rootErr != nil {
		t.Fatal(rootErr)
	}
	defer root.Close()
	checkpoint, master, _ := checkpointFixture(t, dir)
	changed := checkpoint
	changed.Offset = 0
	if verifyResumeCheckpoint(changed, master, time.Now().UnixMilli()) == nil {
		t.Fatal("accepted changed offsetMAC")
	}
	stage, err := os.OpenFile(filepath.Join(dir, checkpoint.StagingID), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	stage.WriteAt([]byte("tampered"), 0)
	stage.Close()
	if _, err = resumeStage(root, checkpoint); err == nil {
		t.Fatal("accepted changed durable prefix")
	}
	if _, err = os.Stat(checkpoint.Destination); !os.IsNotExist(err) {
		t.Fatal("published tampered content")
	}
}
func TestResumeRejectsStagingSymlinkAndUnsafeMetadata(t *testing.T) {
	dir := t.TempDir()
	root, rootErr := os.OpenRoot(dir)
	if rootErr != nil {
		t.Fatal(rootErr)
	}
	defer root.Close()
	checkpoint, _, path := checkpointFixture(t, dir)
	stagePath := filepath.Join(dir, checkpoint.StagingID)
	os.Remove(stagePath)
	outside := filepath.Join(t.TempDir(), "outside")
	os.WriteFile(outside, make([]byte, chunkSize), 0600)
	if err := os.Symlink(outside, stagePath); err == nil {
		if _, err = resumeStage(root, checkpoint); err == nil {
			t.Fatal("accepted staging symlink")
		}
	}
	checkpoint.StagingID = "../outside"
	if _, err := resumeStage(root, checkpoint); err == nil {
		t.Fatal("accepted staging path traversal")
	}
	os.WriteFile(path, []byte(`{}`), 0644)
	exposePrivateTestPath(t, path, 0644)
	var result ResumeCheckpoint
	if resumeReadJSON(path, &result) == nil {
		t.Fatal("accepted exposed checkpoint permissions")
	}
}
func TestResumeSourceDigestDetectsSameSizeChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file.bin")
	os.WriteFile(path, []byte("before"), 0600)
	source, err := prepareSource([]string{path})
	if err != nil {
		t.Fatal(err)
	}
	before, err := resumeSourceDigest(source)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("after!"), 0600)
	after, err := resumeSourceDigest(source)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("same-size source change wasn't detected")
	}
}
func TestResumeCompletionBindsWholeDigest(t *testing.T) {
	digest := hex.EncodeToString(sha256.New().Sum(nil))
	data := resumeEnd(123, digest)
	if err := resumeVerifyEnd(data, 123, digest); err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 1
	if resumeVerifyEnd(data, 123, digest) == nil {
		t.Fatal("accepted modified ENDdigest")
	}
}

func TestResumeMetadataReadSizeBoundary(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, size := range []int{16384, 16385} {
		file, name, err := privatefs.CreateTempRoot(root, ".cd-resume-*")
		if err != nil {
			t.Fatal(err)
		}
		// A valid JSON string at the exact byte limit, then one byte over it.
		data := `"` + strings.Repeat("x", size-2) + `"`
		if _, err = file.WriteString(data); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err = file.Close(); err != nil {
			t.Fatal(err)
		}
		var result string
		err = resumeReadJSONRoot(root, name, &result)
		if size == 16384 {
			if err != nil || len(result) != size-2 {
				t.Fatalf("bounded metadata rejected: bytes=%d, err=%v", len(result), err)
			}
		} else if err == nil {
			t.Fatal("accepted metadata larger than 16 KiB")
		}
	}
}
