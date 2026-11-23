package main

import (
	"bytes"
	"compress/flate"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func compressionInteropCorpus(t testing.TB) map[string][]byte {
	t.Helper()
	source, err := os.ReadFile("protocol.go")
	if err != nil {
		t.Fatal(err)
	}
	random := make([]byte, largeChunkSize)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	ascii := bytes.Clone(random)
	for i := range ascii {
		ascii[i] = 32 + ascii[i]%64
	}
	mixed := bytes.Clone(random)
	clear(mixed[:4096])
	allBytes := make([]byte, largeChunkSize)
	for i := range allBytes {
		allBytes[i] = byte(i)
	}
	return map[string][]byte{
		"empty": nil, "tail": []byte("one byte"),
		"short": bytes.Repeat([]byte{'x'}, 1023), "boundary": bytes.Repeat([]byte{'x'}, 1024),
		"zeros": make([]byte, largeChunkSize), "source": bytes.Repeat(source, 1+largeChunkSize/len(source))[:largeChunkSize],
		"ascii": ascii, "random": random, "deceptive-prefix": mixed, "all-values": allBytes,
	}
}

func TestFastDeflateInteroperability(t *testing.T) {
	var fixtures []map[string]string
	for name, raw := range compressionInteropCorpus(t) {
		t.Run(name, func(t *testing.T) {
			var fast chunkCompressor
			var reference chunkCompressor
			reference.writer, _ = flate.NewWriter(&reference.output, flate.BestSpeed)
			for i := 0; i < 3; i++ {
				input := append([]byte{0}, raw...)
				encoded, err := fast.encode(input)
				if err != nil {
					t.Fatal(err)
				}
				baseline, err := reference.encode(append([]byte{0}, raw...))
				if err != nil {
					t.Fatal(err)
				}
				// Both encoders must preserve raw fallback and its zero-copy
				// storage contract. Compressed bytes may differ by RFC1951 encoder.
				if encoded[0] == 0 && &encoded[0] != &input[0] {
					t.Fatal("raw fallback copied source storage")
				}
				if baseline[0] == 0 && !bytes.Equal(encoded, baseline) && name != "deceptive-prefix" {
					t.Fatal("uncompressed wire fallback changed")
				}
				if len(raw) != 0 {
					var decoder chunkDecompressor
					got, err := decoder.decode(encoded, largeChunkSize)
					decoder.close()
					if err != nil || !bytes.Equal(got, raw) {
						t.Fatalf("standard library decoder rejected optimized RFC1951 encoder: %v", err)
					}
				}
				if encoded[0] == 1 && i == 0 {
					fixtures = append(fixtures, map[string]string{"name": name, "raw": base64.StdEncoding.EncodeToString(raw), "deflated": base64.StdEncoding.EncodeToString(encoded[5:])})
				}
			}
		})
	}
	// Optional standalone browser fixtures for an independent RFC1951 reader.
	// Normal CI tests keep all fixtures in memory and do not write files.
	if path := os.Getenv("CD_COMPRESSION_INTEROP_FIXTURES"); path != "" {
		encoded, err := json.Marshal(fixtures)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func BenchmarkDeflateEncoder(b *testing.B) {
	corpus := compressionInteropCorpus(b)
	for _, name := range []string{"source", "zeros", "random"} {
		raw := corpus[name]
		for _, standard := range []bool{true, false} {
			encoder := "optimized"
			if standard {
				encoder = "stdlib"
			}
			b.Run(name+"/"+encoder, func(b *testing.B) {
				var compressor chunkCompressor
				if standard {
					compressor.writer, _ = flate.NewWriter(&compressor.output, flate.BestSpeed)
				}
				framed := append([]byte{0}, raw...)
				if _, err := compressor.encode(framed); err != nil {
					b.Fatal(err)
				}
				b.SetBytes(int64(len(raw)))
				b.ReportAllocs()
				b.ResetTimer()
				var total int64
				for range b.N {
					encoded, err := compressor.encode(framed)
					if err != nil {
						b.Fatal(err)
					}
					total += int64(len(encoded))
				}
				b.ReportMetric(float64(total)/float64(b.N*len(raw)), "wire/raw")
			})
		}
	}
}
