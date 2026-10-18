package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func writeTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readSource(t *testing.T, source shareSource) []byte {
	t.Helper()
	reader, err := source.open()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBundleSizeMatchesStreamAndExtractsExactly(t *testing.T) {
	root := t.TempDir()
	want := map[string][]byte{
		"project/readme.md":        []byte("hello"),
		"project/src/main.go":      bytes.Repeat([]byte("x"), 300_001),
		"project/empty.bin":        {},
		"project/résumé final.txt": []byte("unicode name"),
		"notes.txt":                []byte("top-level file"),
	}
	for name, data := range want {
		writeTestFile(t, filepath.Join(root, filepath.FromSlash(name)), data)
	}
	if err := os.MkdirAll(filepath.Join(root, "project", "empty-dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink("/etc", filepath.Join(root, "project", "link-out")); err != nil {
			t.Fatal(err)
		}
	}
	source, err := prepareSource([]string{filepath.Join(root, "project"), filepath.Join(root, "notes.txt")})
	if err != nil {
		t.Fatal(err)
	}
	if source.name != "project-and-1-more.zip" {
		t.Fatalf("bundle name = %q", source.name)
	}
	if runtime.GOOS != "windows" && source.skipped != 1 {
		t.Fatalf("skipped = %d, want the symlink skipped", source.skipped)
	}
	data := readSource(t, source)
	if uint64(len(data)) != source.size {
		t.Fatalf("stream is %d bytes, promised %d", len(data), source.size)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]byte{}
	sawEmptyDir := false
	for _, file := range archive.File {
		if strings.HasSuffix(file.Name, "/") {
			sawEmptyDir = sawEmptyDir || file.Name == "project/empty-dir/"
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		contents, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("%s: %v (CRC must match real bytes)", file.Name, err)
		}
		got[file.Name] = contents
	}
	if !sawEmptyDir {
		t.Fatal("empty directory missing from bundle")
	}
	if len(got) != len(want) {
		t.Fatalf("bundle has %d files, want %d: %v", len(got), len(want), got)
	}
	for name, data := range want {
		if !bytes.Equal(got[name], data) {
			t.Fatalf("%s differs", name)
		}
	}
}

func TestSingleFolderBundleIsNamedAfterIt(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "photos", "a.jpg"), []byte("a"))
	source, err := prepareSource([]string{filepath.Join(root, "photos")})
	if err != nil || source.name != "photos.zip" {
		t.Fatalf("source = %q, %v", source.name, err)
	}
}

func TestSingleFileIsSentUnbundled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "report.pdf")
	writeTestFile(t, path, []byte("%PDF"))
	source, err := prepareSource([]string{path})
	if err != nil || source.name != "report.pdf" || source.size != 4 {
		t.Fatalf("source = %#v, %v", source, err)
	}
	if got := readSource(t, source); string(got) != "%PDF" {
		t.Fatalf("contents = %q", got)
	}
}

func TestBundleRejectsDuplicateTopLevelNamesAndMissingPaths(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "a", "same.txt"), []byte("1"))
	writeTestFile(t, filepath.Join(root, "b", "same.txt"), []byte("2"))
	if _, err := prepareSource([]string{filepath.Join(root, "a", "same.txt"), filepath.Join(root, "b", "same.txt")}); err == nil {
		t.Fatal("accepted two top-level entries with one name")
	}
	if _, err := prepareSource([]string{filepath.Join(root, "a"), filepath.Join(root, "missing")}); err == nil || !strings.Contains(err.Error(), "cannot find") {
		t.Fatalf("missing path error = %v", err)
	}
}

func TestBundleFailsWhenAFileChangesMidSend(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "dir", "grows.log")
	writeTestFile(t, path, []byte("short"))
	source, err := prepareSource([]string{filepath.Join(root, "dir")})
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, []byte("much longer now"))
	reader, err := source.open()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err := io.ReadAll(reader); err == nil || !strings.Contains(err.Error(), "changed while it was being sent") {
		t.Fatalf("changed file error = %v", err)
	}
}

func TestBundleMetadataSizeDoesNotReadPayload(t *testing.T) {
	done := make(chan uint64, 1)
	go func() {
		size, _ := bundleSize([]bundleEntry{{name: "large", size: 20 << 30}})
		done <- size
	}()
	select {
	case size := <-done:
		if size != (20<<30)+236 {
			t.Fatalf("size = %d, want %d", size, (20<<30)+236)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("size calculation processed payload bytes")
	}
}

func TestBundleMetadataMatchesZipBoundaries(t *testing.T) {
	for _, count := range []int{0, 1, 65534, 65535, 65536} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			entries := make([]bundleEntry, count)
			for i := range entries {
				entries[i] = bundleEntry{name: fmt.Sprintf("日本語/%d", i), modified: time.Unix(1, 0)}
			}
			want, err := bundleSize(entries)
			if err != nil {
				t.Fatal(err)
			}
			var actual bytes.Buffer
			if err := writeBundle(&actual, entries, func(bundleEntry) (io.ReadCloser, error) {
				return io.NopCloser(bytes.NewReader(nil)), nil
			}); err != nil {
				t.Fatal(err)
			}
			if want != uint64(actual.Len()) {
				t.Fatalf("computed %d, stream %d", want, actual.Len())
			}
		})
	}
}

// CreateRaw and SetOffset exercise archive/zip's real ZIP64 descriptors,
// central headers, and end records without generating a four-GiB payload.
func TestBundleMetadataZip64Sizes(t *testing.T) {
	for _, size := range []uint64{1<<32 - 31, 1<<32 - 1, 1 << 32, 20 << 30} {
		entry := bundleEntry{name: "large", size: size}
		want, err := bundleSize([]bundleEntry{entry, {name: "after"}})
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		archive := zip.NewWriter(&output)
		archive.SetOffset(int64(size))
		_, err = archive.CreateRaw(&zip.FileHeader{Name: entry.name, Method: zip.Store, Flags: 8,
			CompressedSize64: size, UncompressedSize64: size})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := archive.CreateRaw(&zip.FileHeader{Name: "after", Method: zip.Store, Flags: 8}); err != nil {
			t.Fatal(err)
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		if got := size + uint64(output.Len()); want != got {
			t.Fatalf("size %d: computed %d, zip %d", size, want, got)
		}
	}
}

func TestBundleMetadataRejectsOverflowAndLongNames(t *testing.T) {
	for _, entries := range [][]bundleEntry{
		{{name: strings.Repeat("n", 65536)}},
		{{name: "huge", size: 1<<63 - 1}},
		{{name: "a", size: 1 << 62}, {name: "b", size: 1 << 62}},
	} {
		if _, err := bundleSize(entries); err == nil {
			t.Fatal("accepted unrepresentable archive")
		}
	}
}
