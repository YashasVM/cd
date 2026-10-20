package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestChunkAcceptanceCompatibilityAndLimits(t *testing.T) {
	for _, test := range []struct {
		name      string
		payload   string
		max, want int
		valid     bool
	}{
		{"old receiver", "", largeChunkSize, chunkSize, true},
		{"large", `{"chunkSize":786432}`, largeChunkSize, largeChunkSize, true},
		{"explicit original", `{"chunkSize":262144}`, 0, chunkSize, true},
		{"unadvertised", `{"chunkSize":786432}`, 0, 0, false},
		{"too large", `{"chunkSize":1048576}`, largeChunkSize, 0, false},
		{"unsupported", `{"chunkSize":524288}`, largeChunkSize, 0, false},
		{"missing", `{}`, largeChunkSize, 0, false},
		{"null", `null`, largeChunkSize, 0, false},
		{"malformed", `{`, largeChunkSize, 0, false},
		{"trailing", `{"chunkSize":786432} {}`, largeChunkSize, 0, false},
		{"unknown", `{"chunkSize":786432,"other":true}`, largeChunkSize, 0, false},
		{"negative", `{"chunkSize":-1}`, largeChunkSize, 0, false},
		{"fraction", `{"chunkSize":786432.5}`, largeChunkSize, 0, false},
		{"string", `{"chunkSize":"786432"}`, largeChunkSize, 0, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := acceptedChunkSize([]byte(test.payload), test.max)
			if (err == nil) != test.valid || got != test.want {
				t.Fatalf("got %d,%v; want %d,valid=%v", got, err, test.want, test.valid)
			}
		})
	}
}

func TestReceiveChunkSelectionPreservesLegacyOffers(t *testing.T) {
	t.Setenv("CD_LARGE_RECORDS", "1")
	for _, size := range []int{chunkSizeLegacy, chunkSize} {
		got, payload := receiveChunkSelection(fileOffer{ChunkSize: size})
		if got != size || len(payload) != 0 {
			t.Fatalf("legacy %d became %d,%s", size, got, payload)
		}
	}
	got, payload := receiveChunkSelection(fileOffer{ChunkSize: chunkSize, MaxChunkSize: largeChunkSize})
	if got != largeChunkSize || string(payload) != `{"chunkSize":786432}` {
		t.Fatalf("selection=%d,%s", got, payload)
	}
	t.Setenv("CD_LARGE_RECORDS", "0")
	got, payload = receiveChunkSelection(fileOffer{ChunkSize: chunkSize, MaxChunkSize: largeChunkSize})
	if got != chunkSize || len(payload) != 0 {
		t.Fatalf("disabled selection=%d,%s", got, payload)
	}
}

func TestReceiveRejectsChunksBeyondNegotiatedLimits(t *testing.T) {
	for _, test := range []struct {
		length, limit  int
		received, size uint64
		valid          bool
	}{
		{largeChunkSize, largeChunkSize, 0, largeChunkSize, true},
		{19, largeChunkSize, largeChunkSize, largeChunkSize + 19, true},
		{largeChunkSize, chunkSize, 0, largeChunkSize, false},
		{largeChunkSize + 1, largeChunkSize, 0, 2 * largeChunkSize, false},
		{0, largeChunkSize, 0, 1, false},
		{2, largeChunkSize, 9, 10, false},
		{2, largeChunkSize, ^uint64(0), 10, false},
	} {
		if err := validateReceivedChunk(make([]byte, test.length), test.limit, test.received, test.size); (err == nil) != test.valid {
			t.Fatalf("%+v: %v", test, err)
		}
	}
	offer := fileOffer{Name: "safe.bin", MediaType: "application/octet-stream", Size: "0", ChunkSize: chunkSize, MaxChunkSize: largeChunkSize + 1}
	encoded, _ := json.Marshal(offer)
	if _, _, err := parseReceivedOffer(encoded); err == nil {
		t.Fatal("accepted unsupported offered maximum")
	}
}

func TestNegotiatedChunksAcrossEncryptedRelay(t *testing.T) {
	for _, test := range []struct {
		name, enabled string
		oldReceiver   bool
		wantChunk     int
	}{
		{"new-new", "1", false, largeChunkSize},
		{"new-old", "1", true, chunkSize},
		{"old-new", "0", false, chunkSize},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("CD_LARGE_RECORDS", test.enabled)
			sender, receiver, _ := linkedPair(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			original := bytes.Repeat([]byte("payload-"), 2*largeChunkSize/8+31)
			done := make(chan error, 1)
			go func() {
				done <- transfer(ctx, sender, bytes.NewReader(original), readyOutput{Filename: "payload.bin", Size: uint64(len(original))}, nil, sendHooks{})
			}()
			kind, payload, err := receiver.next(ctx, time.Second)
			if err != nil || kind != kindOffer {
				t.Fatalf("offer: %v,%v", kind, err)
			}
			offer, size, err := parseReceivedOffer(payload)
			if err != nil {
				t.Fatal(err)
			}
			if offer.ChunkSize != chunkSize {
				t.Fatal("broke legacy advertised size")
			}
			selected, acceptance := receiveChunkSelection(offer)
			if test.oldReceiver {
				selected, acceptance = offer.ChunkSize, nil
			}
			if selected != test.wantChunk {
				t.Fatalf("selected %d", selected)
			}
			if err := receiver.send(kindAccept, acceptance); err != nil {
				t.Fatal(err)
			}
			var received bytes.Buffer
			var chunks uint32
			for {
				kind, payload, err = receiver.next(ctx, time.Second)
				if err != nil {
					t.Fatal(err)
				}
				if kind == kindEnd {
					break
				}
				if kind != kindChunk {
					t.Fatalf("unexpected kind %d", kind)
				}
				if err := validateReceivedChunk(payload, selected, uint64(received.Len()), size); err != nil {
					t.Fatal(err)
				}
				expected := min(selected, len(original)-received.Len())
				if len(payload) != expected {
					t.Fatalf("chunk length %d, want %d", len(payload), expected)
				}
				received.Write(payload)
				chunks++
				if err := receiver.send(kindAck, encodeCounts(chunks, uint64(received.Len()))); err != nil {
					t.Fatal(err)
				}
			}
			endChunks, endBytes, err := decodeCounts(payload)
			if err != nil || endChunks != chunks || endBytes != size || !bytes.Equal(received.Bytes(), original) {
				t.Fatal("encrypted transfer changed payload or counts")
			}
			if err := receiver.send(kindComplete, encodeCounts(chunks, size)); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}
