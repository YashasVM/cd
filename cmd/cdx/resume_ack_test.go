package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

const testResumeAckBatch = 1024 * 1024

// Exercise the actual authenticated receiver and on-disk checkpoints, not a
// stand-in that merely promises durable ACKs.
type resumeAckFixture struct {
	t       *testing.T
	h       *deviceTransferHarness
	dir     string
	invite  invitation
	expiry  int64
	payload []byte
	digest  string
}

type resumeAckRun struct {
	*resumeAckFixture
	session  *resumeSession
	done     chan error
	cancel   context.CancelFunc
	finished bool
}

func newResumeAckFixture(t *testing.T, size int) *resumeAckFixture {
	t.Helper()
	h := newDeviceTransferHarness(t)
	deviceTransferEnvironment(t, h.server.URL)
	deviceTestOutput(t)
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte((i*31 + i/251) % 256)
	}
	digest := sha256.Sum256(payload)
	return &resumeAckFixture{t: t, h: h, dir: t.TempDir(), invite: testInvitation(), expiry: time.Now().Add(time.Hour).UnixMilli(), payload: payload, digest: hex.EncodeToString(digest[:])}
}

func (f *resumeAckFixture) checkpointPath() string {
	return filepath.Join(f.dir, ".cd-"+f.invite.encodedID()+".checkpoint.json")
}

func (f *resumeAckFixture) checkpoint(offset int64) ResumeCheckpoint {
	f.t.Helper()
	var checkpoint ResumeCheckpoint
	if err := resumeReadJSON(f.checkpointPath(), &checkpoint); err != nil {
		f.t.Fatal(err)
	}
	if err := verifyResumeCheckpoint(checkpoint, f.invite.key[:], time.Now().UnixMilli()); err != nil {
		f.t.Fatalf("checkpoint authentication: %v", err)
	}
	prefix := sha256.Sum256(f.payload[:offset])
	if checkpoint.Offset != offset || checkpoint.PrefixSHA256 != hex.EncodeToString(prefix[:]) {
		f.t.Fatalf("durable checkpoint = %d/%s; want %d/%x", checkpoint.Offset, checkpoint.PrefixSHA256, offset, prefix)
	}
	stage, err := os.ReadFile(filepath.Join(f.dir, checkpoint.StagingID))
	if err != nil || int64(len(stage)) < offset || !bytes.Equal(stage[:offset], f.payload[:offset]) {
		f.t.Fatalf("checkpoint does not describe the retained prefix: size=%d, error=%v", len(stage), err)
	}
	return checkpoint
}

func (f *resumeAckFixture) start(window, offset int64) *resumeAckRun {
	f.t.Helper()
	local := f.h.arm(f.invite, f.expiry)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	run := &resumeAckRun{resumeAckFixture: f, done: make(chan error, 1), cancel: cancel}
	go func() {
		run.done <- receiveResumable(ctx, receiveRequest{code: f.h.server.URL + "/s/" + f.invite.encodedID() + "#v2." + f.invite.encodedKey(), out: f.dir, jsonOutput: true})
	}()
	f.t.Cleanup(func() {
		cancel()
		if run.session != nil {
			run.session.close()
		}
		if !run.finished {
			select {
			case <-run.done:
			case <-time.After(5 * time.Second):
				f.t.Error("receiver did not stop")
			}
		}
	})
	select {
	case run.session = <-local.Sessions:
	case <-ctx.Done():
		f.t.Fatal(ctx.Err())
	}
	offer, _ := json.Marshal(resumeOffer{Name: "payload.bin", Size: strconv.Itoa(len(f.payload)), ChunkSize: chunkSize, WholeSHA256: f.digest, ExpiresAt: f.expiry, WindowBytes: window})
	if err := run.session.send(kindOffer, offer); err != nil {
		f.t.Fatal(err)
	}
	kind, data, err := run.session.next()
	if err != nil || kind != kindAccept {
		f.t.Fatalf("accept: kind=%v, error=%v", kind, err)
	}
	var accept struct {
		Offset        string          `json:"offset"`
		PrefixSHA256  string          `json:"prefixSha256"`
		AckEveryBytes json.RawMessage `json:"ackEveryBytes"`
	}
	if err = json.Unmarshal(data, &accept); err != nil {
		f.t.Fatal(err)
	}
	checkpoint := f.checkpoint(offset)
	if accept.Offset != strconv.FormatInt(offset, 10) || accept.PrefixSHA256 != checkpoint.PrefixSHA256 {
		f.t.Fatalf("accepted prefix differs from checkpoint: %s", data)
	}
	if window >= testResumeAckBatch {
		// Raw JSON also proves this is a number, not a string.
		if string(accept.AckEveryBytes) != strconv.Itoa(testResumeAckBatch) {
			f.t.Errorf("negotiated ackEveryBytes = %s; want numeric %d", accept.AckEveryBytes, testResumeAckBatch)
		}
	} else if len(accept.AckEveryBytes) != 0 {
		f.t.Errorf("legacy acceptance advertised ackEveryBytes: %s", accept.AckEveryBytes)
	}
	return run
}

func (r *resumeAckRun) chunks(start, end int) {
	r.t.Helper()
	for start < end {
		next := min(start+chunkSize, end)
		if err := r.session.send(kindChunk, r.payload[start:next]); err != nil {
			r.t.Fatal(err)
		}
		start = next
	}
}

func (r *resumeAckRun) ack(offset int64) {
	r.t.Helper()
	kind, data, err := r.session.next()
	if err != nil || kind != kindAck {
		r.t.Fatalf("ACK: kind=%v, error=%v", kind, err)
	}
	chunks, got, err := decodeCounts(data)
	if err != nil || got != uint64(offset) || chunks != resumeCounts(uint64(offset)) {
		r.t.Fatalf("ACK = %d bytes/%d chunks, error=%v; want %d bytes", got, chunks, err, offset)
	}
	r.checkpoint(offset)
	if _, err := os.Stat(filepath.Join(r.dir, "payload.bin")); !os.IsNotExist(err) {
		r.t.Fatalf("ACK published before whole-file verification: %v", err)
	}
}

func (r *resumeAckRun) result(wantError bool) {
	r.t.Helper()
	select {
	case err := <-r.done:
		r.finished = true
		if (err != nil) != wantError {
			r.t.Fatalf("receive error = %v; want error=%v", err, wantError)
		}
	case <-time.After(10 * time.Second):
		r.t.Fatal("receiver did not finish")
	}
}

func (r *resumeAckRun) complete() {
	r.t.Helper()
	if err := r.session.send(kindEnd, resumeEnd(uint64(len(r.payload)), r.digest)); err != nil {
		r.t.Fatal(err)
	}
	kind, data, err := r.session.next()
	if err != nil || kind != kindComplete {
		r.t.Fatalf("complete (no extra ACKs): kind=%v, error=%v", kind, err)
	}
	if err = resumeVerifyEnd(data, uint64(len(r.payload)), r.digest); err != nil {
		r.t.Fatal(err)
	}
	if err = r.session.terminal(false); err != nil {
		r.t.Fatal(err)
	}
	r.result(false)
	got, err := os.ReadFile(filepath.Join(r.dir, "payload.bin"))
	if err != nil || !bytes.Equal(got, r.payload) {
		r.t.Fatalf("published bytes differ: %v", err)
	}
	if _, err = os.Stat(r.checkpointPath()); !os.IsNotExist(err) {
		r.t.Fatalf("completed checkpoint remains: %v", err)
	}
}

func TestResumeReceiverNegotiatesDurableAckBatches(t *testing.T) {
	for _, window := range []int64{-1, 0, chunkSize, testResumeAckBatch - 1, testResumeAckBatch, 4 * testResumeAckBatch} {
		t.Run(strconv.FormatInt(window, 10), func(t *testing.T) {
			f := newResumeAckFixture(t, 2*testResumeAckBatch+17)
			r := f.start(window, 0)
			batch := chunkSize
			if window >= testResumeAckBatch {
				batch = testResumeAckBatch
			}
			for offset := 0; offset < len(f.payload); {
				next := min(offset+batch, len(f.payload))
				r.chunks(offset, next)
				// In particular, the final partial batch must ACK before END;
				// the sender will not send END until that ACK arrives.
				r.ack(int64(next))
				offset = next
			}
			r.complete()
		})
	}
}

func TestResumeReceiverAckBatchEmptySmallAndAlignedFiles(t *testing.T) {
	for _, size := range []int{0, 17, chunkSize, testResumeAckBatch, testResumeAckBatch + chunkSize} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			f := newResumeAckFixture(t, size)
			r := f.start(testResumeAckBatch, 0)
			for offset := 0; offset < size; {
				next := min(offset+testResumeAckBatch, size)
				r.chunks(offset, next)
				r.ack(int64(next))
				offset = next
			}
			r.complete()
		})
	}
}

func TestResumeReceiverAckBatchResumesRelativeToDurablePrefix(t *testing.T) {
	f := newResumeAckFixture(t, 3*testResumeAckBatch+17)
	// An older/per-chunk session may retain a prefix that is not MiB-aligned.
	legacy := f.start(0, 0)
	legacy.chunks(0, chunkSize)
	legacy.ack(chunkSize)
	legacy.session.close()
	legacy.result(true)

	incomplete := f.start(testResumeAckBatch, chunkSize)
	incomplete.chunks(chunkSize, testResumeAckBatch)
	// An invalid early END fences the three chunks without relying on a
	// timing-sensitive assertion that a live socket has not sent an ACK yet.
	if err := incomplete.session.send(kindEnd, resumeEnd(uint64(len(f.payload)), f.digest)); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := incomplete.session.next(); err == nil {
		t.Fatalf("uncommitted partial batch emitted a record: %v", kind)
	}
	incomplete.result(true)
	checkpoint := f.checkpoint(chunkSize)
	if info, err := os.Stat(filepath.Join(f.dir, checkpoint.StagingID)); err != nil || info.Size() != testResumeAckBatch {
		t.Fatalf("expected uncommitted tail: info=%v, error=%v", info, err)
	}

	resumed := f.start(testResumeAckBatch, chunkSize)
	checkpoint = f.checkpoint(chunkSize)
	if info, err := os.Stat(filepath.Join(f.dir, checkpoint.StagingID)); err != nil || info.Size() != chunkSize {
		t.Fatalf("restart did not truncate uncommitted tail: info=%v, error=%v", info, err)
	}
	committed := chunkSize + testResumeAckBatch
	resumed.chunks(chunkSize, committed)
	resumed.ack(int64(committed))
	resumed.chunks(committed, committed+2*chunkSize)
	if err := resumed.session.send(kindEnd, resumeEnd(uint64(len(f.payload)), f.digest)); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := resumed.session.next(); err == nil {
		t.Fatalf("tail after a committed batch emitted a record: %v", kind)
	}
	resumed.result(true)
	f.checkpoint(int64(committed))

	restarted := f.start(testResumeAckBatch, int64(committed))
	checkpoint = f.checkpoint(int64(committed))
	if info, err := os.Stat(filepath.Join(f.dir, checkpoint.StagingID)); err != nil || info.Size() != int64(committed) {
		t.Fatalf("restart lost acknowledged bytes or retained a tail: info=%v, error=%v", info, err)
	}
	for offset := committed; offset < len(f.payload); {
		next := min(offset+testResumeAckBatch, len(f.payload))
		restarted.chunks(offset, next)
		restarted.ack(int64(next))
		offset = next
	}
	restarted.complete()
}

func TestResumeReceiverDoesNotAckFailedCheckpointBatch(t *testing.T) {
	f := newResumeAckFixture(t, 2*testResumeAckBatch)
	r := f.start(testResumeAckBatch, 0)
	checkpoint := f.checkpoint(0)
	// Make the atomic replacement fail after stage.Sync without mocking away
	// the real durability path. Preserve the last authenticated checkpoint.
	backup := f.checkpointPath() + ".saved"
	if err := os.Rename(f.checkpointPath(), backup); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.checkpointPath(), 0700); err != nil {
		t.Fatal(err)
	}
	r.chunks(0, testResumeAckBatch)
	if kind, _, err := r.session.next(); err == nil {
		t.Fatalf("failed checkpoint emitted a record: %v", kind)
	}
	r.result(true)
	if err := os.Remove(f.checkpointPath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, f.checkpointPath()); err != nil {
		t.Fatal(err)
	}
	f.checkpoint(0)
	if info, err := os.Stat(filepath.Join(f.dir, checkpoint.StagingID)); err != nil || info.Size() != testResumeAckBatch {
		t.Fatalf("failed batch stage = %v, error=%v", info, err)
	}
	resumed := f.start(testResumeAckBatch, 0)
	for offset := 0; offset < len(f.payload); offset += testResumeAckBatch {
		resumed.chunks(offset, offset+testResumeAckBatch)
		resumed.ack(int64(offset + testResumeAckBatch))
	}
	resumed.complete()
}

func TestResumeReceiverAckBatchCancellationRemovesPendingTail(t *testing.T) {
	f := newResumeAckFixture(t, 2*testResumeAckBatch)
	r := f.start(testResumeAckBatch, 0)
	checkpoint := f.checkpoint(0)
	r.chunks(0, chunkSize)
	deadline := time.Now().Add(5 * time.Second)
	for {
		info, err := os.Stat(filepath.Join(f.dir, checkpoint.StagingID))
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() == chunkSize {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("receiver did not write the pending chunk")
		}
		time.Sleep(time.Millisecond)
	}
	f.checkpoint(0)
	r.cancel()
	r.result(true)
	if kind, _, err := r.session.next(); err == nil {
		t.Fatalf("canceled partial batch emitted a record: %v", kind)
	}
	if entries, err := os.ReadDir(f.dir); err != nil || len(entries) != 0 {
		t.Fatalf("cancellation retained private progress: entries=%v, error=%v", entries, err)
	}
}

func TestResumeReceiverAckBatchStillRequiresWholeDigest(t *testing.T) {
	f := newResumeAckFixture(t, testResumeAckBatch+17)
	wrong := sha256.Sum256([]byte("different source"))
	f.digest = hex.EncodeToString(wrong[:])
	r := f.start(testResumeAckBatch, 0)
	r.chunks(0, testResumeAckBatch)
	r.ack(testResumeAckBatch)
	r.chunks(testResumeAckBatch, len(f.payload))
	r.ack(int64(len(f.payload)))
	// END agrees with the offer, but the received bytes do not.
	if err := r.session.send(kindEnd, resumeEnd(uint64(len(f.payload)), f.digest)); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := r.session.next(); err == nil {
		t.Fatalf("wrong whole-file digest emitted a record: %v", kind)
	}
	r.result(true)
	f.checkpoint(int64(len(f.payload)))
	if _, err := os.Stat(filepath.Join(f.dir, "payload.bin")); !os.IsNotExist(err) {
		t.Fatalf("wrong whole-file digest published: %v", err)
	}
}

func TestResumeReceiverAckBatchRejectsInvalidWrittenBounds(t *testing.T) {
	for _, invalid := range []string{"empty", "short", "overrun"} {
		t.Run(invalid, func(t *testing.T) {
			f := newResumeAckFixture(t, 3*chunkSize+17)
			r := f.start(testResumeAckBatch, 0)
			data := []byte{}
			switch invalid {
			case "short":
				data = f.payload[:17]
			case "overrun":
				r.chunks(0, 3*chunkSize)
				data = f.payload[:chunkSize]
			}
			if err := r.session.send(kindChunk, data); err != nil {
				t.Fatal(err)
			}
			if kind, _, err := r.session.next(); err == nil {
				t.Fatalf("invalid chunk emitted a record: %v", kind)
			}
			r.result(true)
			f.checkpoint(0)
		})
	}
}
