package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestDirectAssemblyOwnsRecordsAcrossFragmentReuse(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	first, _ := sealer.sealInto(nil, kindChunk, bytes.Repeat([]byte{0x51}, largeChunkSize))
	second, _ := sealer.sealInto(nil, kindEnd, encodeCounts(1, largeChunkSize))
	stream := append(bytes.Clone(first), second...)
	for _, pieceSize := range []int{1, 7, headerBytes, directPieceSize, len(stream)} {
		var assembler recordAssembler
		var records [][]byte
		// A WebRTC implementation may reuse its callback storage. The
		// assembled records must own their bytes even before decryption.
		piece := make([]byte, pieceSize)
		for start := 0; start < len(stream); start += pieceSize {
			n := copy(piece, stream[start:min(start+pieceSize, len(stream))])
			got, err := assembler.push(piece[:n])
			if err != nil {
				t.Fatal(err)
			}
			records = append(records, got...)
			clear(piece)
		}
		if len(records) != 2 || !bytes.Equal(records[0], first) || !bytes.Equal(records[1], second) {
			t.Fatalf("fragment size %d corrupted records", pieceSize)
		}
		if len(assembler.buffer) != 0 {
			t.Fatal("completed record retained in assembler")
		}
	}
}

func TestDirectAssemblyRejectsOversizedHeaderBeforeBody(t *testing.T) {
	header := make([]byte, headerBytes)
	copy(header, []byte{'C', 'D', protocolVersion, byte(kindChunk)})
	for _, size := range []uint32{maxRecordBytes, ^uint32(0)} {
		binary.BigEndian.PutUint32(header[8:12], size)
		for _, split := range []int{0, 1, headerBytes - 1} {
			var assembler recordAssembler
			if _, err := assembler.push(header[:split]); err != nil {
				t.Fatal(err)
			}
			if _, err := assembler.push(header[split:]); err == nil {
				t.Fatalf("accepted size %d with header split at %d", size, split)
			}
			if cap(assembler.buffer) > headerBytes {
				t.Fatal("allocated record storage before validating length")
			}
		}
	}
}

func TestDirectAssemblySplitsAtEveryHeaderByte(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	want, _ := sealer.sealInto(nil, kindChunk, []byte("fragmented authenticated header"))
	for split := 1; split < headerBytes; split++ {
		var assembler recordAssembler
		if got, err := assembler.push(want[:split]); err != nil || len(got) != 0 {
			t.Fatalf("early record at split %d: %v", split, err)
		}
		got, err := assembler.push(want[split:])
		if err != nil || len(got) != 1 || !bytes.Equal(got[0], want) {
			t.Fatalf("split %d: %v", split, err)
		}
	}
}
