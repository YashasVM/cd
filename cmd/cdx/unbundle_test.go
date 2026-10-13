package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	output, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(output)
	for name, contents := range files {
		writer, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	_ = output.Close()
}

func TestUnpackBundleRestoresFilesAndFolders(t *testing.T) {
	source := t.TempDir()
	if err := os.MkdirAll(filepath.Join(source, "docs", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(source, "a.txt"), []byte("alpha"), 0o644)
	_ = os.WriteFile(filepath.Join(source, "docs", "deep", "note.md"), []byte("nested"), 0o644)
	bundle, err := prepareBundle([]string{filepath.Join(source, "a.txt"), filepath.Join(source, "docs")})
	if err != nil {
		t.Fatal(err)
	}
	if bundle.files != 2 {
		t.Fatalf("files = %d, want 2", bundle.files)
	}
	archivePath := filepath.Join(t.TempDir(), "bundle.zip")
	reader, _ := bundle.open()
	output, _ := os.Create(archivePath)
	if _, err := output.ReadFrom(reader); err != nil {
		t.Fatal(err)
	}
	_ = output.Close()

	dest := t.TempDir()
	files, err := unpackBundle(archivePath, dest, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || files[0].Filename != "a.txt" || files[1].Filename != "docs/deep/note.md" {
		t.Fatalf("files = %+v", files)
	}
	if data, _ := os.ReadFile(filepath.Join(dest, "docs", "deep", "note.md")); string(data) != "nested" {
		t.Fatalf("note.md = %q", data)
	}

	// A second unpack clashes and writes nothing without --force.
	_, err = unpackBundle(archivePath, dest, false)
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v, want exists", err)
	}
	if _, err := unpackBundle(archivePath, dest, true); err != nil {
		t.Fatalf("force: %v", err)
	}
}

func TestUnpackBundleRefusesUnsafeNames(t *testing.T) {
	for _, name := range []string{"../escape.txt", "/abs.txt", `a\b.txt`, "a/../../b.txt"} {
		archivePath := filepath.Join(t.TempDir(), "evil.zip")
		writeTestZip(t, archivePath, map[string]string{name: "x"})
		dest := t.TempDir()
		if _, err := unpackBundle(archivePath, dest, false); err == nil {
			t.Fatalf("%q: unpacked", name)
		}
	}
}

func TestResolveBundleDir(t *testing.T) {
	base := t.TempDir()
	fresh := filepath.Join(base, "new", "folder")
	if dir, err := resolveBundleDir(fresh); err != nil || dir != fresh {
		t.Fatalf("dir = %q, err = %v", dir, err)
	}
	file := filepath.Join(base, "file.txt")
	_ = os.WriteFile(file, nil, 0o644)
	if _, err := resolveBundleDir(file); err == nil {
		t.Fatal("accepted a file as the bundle folder")
	}
}
