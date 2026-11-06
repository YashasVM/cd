package main

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestBundleSizeMatchesZIPLayout(t *testing.T) {
	for _, entries := range [][]bundleEntry{
		nil,
		{{name: "empty"}},
		{{name: "dir/", dir: true}, {name: "dir/é.txt", size: 37, modified: time.Unix(1700000000, 0)}},
		{{name: "a", size: 65537}, {name: "long-" + strings.Repeat("x", 2048), size: 5}},
		{{name: strings.Repeat("x", 65535)}},
	} {
		var out bytes.Buffer
		if err := writeBundle(&out, entries, func(entry bundleEntry) (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(make([]byte, entry.size))), nil
		}); err != nil {
			t.Fatal(err)
		}
		size, err := bundleSize(entries)
		if err != nil || size != uint64(out.Len()) {
			t.Fatalf("size = %d, %v; emitted %d", size, err, out.Len())
		}
	}
}

func TestBundleSizeZIP64VirtualPayload(t *testing.T) {
	const max32 = uint64(1<<32 - 1)
	for _, test := range []struct {
		name    string
		entries []bundleEntry
		want    uint64
	}{
		{"below", []bundleEntry{{name: "a", size: max32 - 1000}}, max32 - 1000 + 116},
		{"archive-offset", []bundleEntry{{name: "a", size: max32 - 1}}, max32 - 1 + 116 + 76},
		{"file-size", []bundleEntry{{name: "a", size: max32}}, max32 + 116 + 8 + 28 + 76},
		{"next-file-offset", []bundleEntry{{name: "a", size: max32}, {name: "b"}}, max32 + 116 + 8 + 28 + 94 + 28 + 76},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := bundleSize(test.entries)
			if err != nil || got != test.want {
				t.Fatalf("size = %d, %v; want %d", got, err, test.want)
			}
		})
	}
}

func TestBundleSizeZIP64HeadersMatchArchiveWriter(t *testing.T) {
	const max32 = uint64(1<<32 - 1)
	for _, size := range []uint64{max32 - 1, max32, max32 + 1} {
		var out bytes.Buffer
		archive := zip.NewWriter(&out)
		// Raw headers let archive/zip emit the real ZIP64 descriptor and
		// central size fields without allocating or checksumming 4 GiB.
		_, err := archive.CreateRaw(&zip.FileHeader{Name: "a", Method: zip.Store, Flags: 8, CompressedSize64: size, UncompressedSize64: size})
		if err != nil {
			t.Fatal(err)
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		got, err := bundleSize([]bundleEntry{{name: "a", size: size}})
		// The raw writer omitted payload bytes, so its central-directory
		// offset fits in 32 bits. The full stream adds ZIP64 end records.
		if err != nil || got != size+uint64(out.Len())+76 {
			t.Fatalf("payload %d: size = %d, %v; raw ZIP overhead %d", size, got, err, out.Len())
		}
	}
}

func TestBundleSizeZIP64EntryCount(t *testing.T) {
	entries := make([]bundleEntry, 65535)
	for i := range entries {
		entries[i] = bundleEntry{name: "a"}
	}
	var out bytes.Buffer
	if err := writeBundle(&out, entries, func(bundleEntry) (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("")), nil }); err != nil {
		t.Fatal(err)
	}
	got, err := bundleSize(entries)
	if err != nil || got != uint64(out.Len()) {
		t.Fatalf("size = %d, %v; emitted %d", got, err, out.Len())
	}
	if got != 65535*94+22+76 {
		t.Fatalf("ZIP64 end records missing: %d", got)
	}
}

func TestBundleSizeRejectsInvalidSizes(t *testing.T) {
	for _, entries := range [][]bundleEntry{
		{{name: strings.Repeat("x", 65536)}},
		{{name: "a", size: ^uint64(0)}},
	} {
		if _, err := bundleSize(entries); err == nil {
			t.Fatal("accepted invalid ZIP size")
		}
	}
}

func BenchmarkBundleSizeMetadata(b *testing.B) {
	for _, test := range []struct {
		name string
		size uint64
	}{{"1MiB", 1 << 20}, {"1TiB", 1 << 40}} {
		b.Run(test.name, func(b *testing.B) {
			entries := []bundleEntry{{name: "payload", size: test.size, modified: time.Unix(1700000000, 0)}}
			b.ReportAllocs()
			for range b.N {
				if _, err := bundleSize(entries); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
