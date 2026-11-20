package main

import (
	"encoding/binary"
	"fmt"
	"testing"
)

// BenchmarkDirectRecordAssembly measures the actual 64 KiB data-channel
// fragment path. It includes ownership of the assembled record, but excludes
// WebRTC and encryption so allocation/copy costs are visible independently.
func BenchmarkDirectRecordAssembly(b *testing.B) {
	for _, size := range []int{chunkSize, largeChunkSize} {
		b.Run(fmt.Sprintf("%dKiB", size>>10), func(b *testing.B) {
			record := make([]byte, headerBytes+size+recordTagBytes)
			copy(record, []byte{'C', 'D', protocolVersion, byte(kindChunk)})
			binary.BigEndian.PutUint32(record[8:12], uint32(size))
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				var assembler recordAssembler
				emitted := 0
				for start := 0; start < len(record); start += directPieceSize {
					records, err := assembler.push(record[start:min(start+directPieceSize, len(record))])
					if err != nil {
						b.Fatal(err)
					}
					if len(records) > 0 && len(records[0]) != len(record) {
						b.Fatal("incorrect assembled length")
					}
					emitted += len(records)
				}
				if emitted != 1 {
					b.Fatal("incorrect assembled record count")
				}
			}
		})
	}
}
