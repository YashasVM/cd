package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestResumeReceiverBatchesOnlyDurableAcksWithinSendWindow(t *testing.T) {
	for _, test := range []struct{ window, interval int64 }{
		{0, chunkSize}, {chunkSize, chunkSize}, {3*chunkSize + 17, 3 * chunkSize}, {4 * 1024 * 1024, 4 * 1024 * 1024}, {8 * 1024 * 1024, 4 * 1024 * 1024}, {-1, 0}, {chunkSize - 1, 0},
	} {
		t.Run(fmt.Sprint(test.window), func(t *testing.T) {
			h := newDeviceTransferHarness(t)
			deviceTransferEnvironment(t, h.server.URL)
			deviceTestOutput(t)
			invite := testInvitation()
			expiry := time.Now().Add(time.Hour).UnixMilli()
			local := h.arm(invite, expiry)
			destination := filepath.Join(t.TempDir(), "received.bin")
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			result := make(chan error, 1)
			go func() {
				result <- receiveResumable(ctx, receiveRequest{resume: true, code: h.server.URL + "/s/" + invite.encodedID() + "#v2." + invite.encodedKey(), out: destination, jsonOutput: true})
			}()
			var session *resumeSession
			select {
			case session = <-local.Sessions:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			defer session.close()
			want := bytes.Repeat([]byte{0x42}, 5*1024*1024+17)
			digest := sha256.Sum256(want)
			offer, _ := json.Marshal(resumeOffer{Name: "payload.bin", Size: strconv.Itoa(len(want)), ChunkSize: chunkSize, WholeSHA256: hex.EncodeToString(digest[:]), ExpiresAt: expiry, WindowBytes: test.window})
			if err := session.send(kindOffer, offer); err != nil {
				t.Fatal(err)
			}
			if test.interval == 0 {
				if err := waitDeviceResult(t, ctx, result); err == nil || classifyFailure(err) != failureProtocol {
					t.Fatalf("accepted invalid send window: %v", err)
				}
				return
			}
			kind, data, err := session.next()
			var accept struct {
				AckEveryBytes int64 `json:"ackEveryBytes"`
			}
			if err != nil || kind != kindAccept || json.Unmarshal(data, &accept) != nil || accept.AckEveryBytes != test.interval {
				t.Fatalf("accept %d %s: %v", kind, data, err)
			}
			_, checkpointPath, err := resumeDest("payload.bin", destination, invite.encodedID())
			if err != nil {
				t.Fatal(err)
			}
			acknowledged := 0
			for offset := 0; offset < len(want); {
				end := min(offset+chunkSize, len(want))
				if err := session.send(kindChunk, want[offset:end]); err != nil {
					t.Fatal(err)
				}
				offset = end
				if offset-acknowledged < int(test.interval) && offset != len(want) {
					continue
				}
				kind, data, err := session.next()
				chunks, ack, decodeErr := decodeCounts(data)
				if err != nil || decodeErr != nil || kind != kindAck || ack != uint64(offset) || chunks != resumeCounts(uint64(offset)) {
					t.Fatalf("ack at %d: %d %d %v %v", offset, kind, ack, err, decodeErr)
				}
				var checkpoint ResumeCheckpoint
				if err := resumeReadJSON(checkpointPath, &checkpoint); err != nil {
					t.Fatal(err)
				}
				if err := verifyResumeCheckpoint(checkpoint, invite.key[:], time.Now().UnixMilli()); err != nil {
					t.Fatal(err)
				}
				prefix := sha256.Sum256(want[:offset])
				if checkpoint.Offset != int64(offset) || checkpoint.PrefixSHA256 != hex.EncodeToString(prefix[:]) {
					t.Fatalf("ACK preceded matching checkpoint: %+v", checkpoint)
				}
				acknowledged = offset
			}
			end := resumeEnd(uint64(len(want)), hex.EncodeToString(digest[:]))
			if err := session.send(kindEnd, end); err != nil {
				t.Fatal(err)
			}
			kind, data, err = session.next()
			if err != nil || kind != kindComplete || !bytes.Equal(data, end) {
				t.Fatalf("complete %d: %v", kind, err)
			}
			if err := session.terminal(false); err != nil {
				t.Fatal(err)
			}
			if err := waitDeviceResult(t, ctx, result); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(destination)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("published payload differs: %v", err)
			}
		})
	}
}
