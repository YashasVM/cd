package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestRecordConsumeUsesOwnedCiphertext(t *testing.T) {
	for _, size := range []int{0, 17, 256 << 10, 768 << 10} {
		sealer, _ := newSealer(testInvitation(), senderDirection)
		opener, _ := newOpener(testInvitation(), senderDirection)
		want := bytes.Repeat([]byte{0x91}, size)
		record, err := sealer.sealInto(nil, kindChunk, want)
		if err != nil {
			t.Fatal(err)
		}
		header := bytes.Clone(record[:headerBytes])
		kind, plaintext, err := opener.consume(record)
		if err != nil || kind != kindChunk || !bytes.Equal(plaintext, want) {
			t.Fatalf("size %d: kind %d, err %v", size, kind, err)
		}
		if size > 0 && &plaintext[0] != &record[headerBytes] {
			t.Fatal("plaintext does not share ciphertext storage")
		}
		if !bytes.Equal(header, record[:headerBytes]) {
			t.Fatal("record header changed")
		}
		if opener.sequence != 1 {
			t.Fatal("successful record did not advance sequence")
		}
	}
}

func TestRecordOpenPreservesCiphertext(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	opener, _ := newOpener(testInvitation(), senderDirection)
	record, _ := sealer.sealInto(nil, kindChunk, []byte("original ciphertext stays available"))
	original := bytes.Clone(record)
	_, plaintext, err := opener.open(record)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(record, original) {
		t.Fatal("open changed ciphertext")
	}
	plaintext[0] ^= 1
	if !bytes.Equal(record, original) {
		t.Fatal("plaintext aliases preserved record")
	}
}

func TestRecordConsumeRejectsInvalidRecordsWithoutAdvancing(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func([]byte) []byte
	}{
		{"short", func(p []byte) []byte { return p[:3] }},
		{"protocol", func(p []byte) []byte { p[2] ^= 1; return p }},
		{"kind", func(p []byte) []byte { p[3] = 255; return p }},
		{"sequence", func(p []byte) []byte { binary.BigEndian.PutUint32(p[4:8], 1); return p }},
		{"length", func(p []byte) []byte { binary.BigEndian.PutUint32(p[8:12], 99); return p }},
		{"authentication", func(p []byte) []byte { p[len(p)-1] ^= 1; return p }},
	} {
		t.Run(test.name, func(t *testing.T) {
			sealer, _ := newSealer(testInvitation(), senderDirection)
			opener, _ := newOpener(testInvitation(), senderDirection)
			original, _ := sealer.sealInto(nil, kindChunk, []byte("authenticated payload"))
			if _, _, err := opener.consume(test.change(bytes.Clone(original))); err == nil {
				t.Fatal("accepted invalid record")
			}
			if opener.sequence != 0 {
				t.Fatal("failure advanced sequence")
			}
			if _, plaintext, err := opener.consume(original); err != nil || string(plaintext) != "authenticated payload" {
				t.Fatalf("valid record rejected after failure: %v", err)
			}
		})
	}
}

func TestRecordConsumeRejectsReplayAndWrongTransfer(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	record, _ := sealer.sealInto(nil, kindChunk, []byte("bound to one transfer"))
	opener, _ := newOpener(testInvitation(), senderDirection)
	if _, _, err := opener.consume(bytes.Clone(record)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := opener.consume(bytes.Clone(record)); err == nil || opener.sequence != 1 {
		t.Fatal("replay accepted or advanced sequence")
	}
	opener.sequence = uint64(1) << 32
	if _, _, err := opener.consume(bytes.Clone(record)); err == nil || opener.sequence != uint64(1)<<32 {
		t.Fatal("exhausted sequence accepted or advanced")
	}
	other := testInvitation()
	other.id[0] ^= 1
	opener, _ = newOpener(other, senderDirection)
	if _, _, err := opener.consume(bytes.Clone(record)); err == nil || opener.sequence != 0 {
		t.Fatal("record for another transfer accepted or advanced sequence")
	}
}

func BenchmarkRecordOpenStorage(b *testing.B) {
	for _, consume := range []bool{false, true} {
		name := "preserve"
		if consume {
			name = "consume"
		}
		b.Run(name, func(b *testing.B) {
			sealer, _ := newSealer(testInvitation(), senderDirection)
			opener, _ := newOpener(testInvitation(), senderDirection)
			record, err := sealer.sealInto(nil, kindChunk, make([]byte, 768<<10))
			if err != nil {
				b.Fatal(err)
			}
			owned := make([]byte, len(record))
			b.SetBytes(768 << 10)
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				opener.sequence = 0
				if consume {
					copy(owned, record)
					_, _, err = opener.consume(owned)
				} else {
					_, _, err = opener.open(record)
				}
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
