package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestChecksumFor(t *testing.T) {
	sums := []byte("abc  cdx-linux-amd64\nDEF *cdx-windows-amd64.exe\n")
	if got, ok := checksumFor(sums, "cdx-windows-amd64.exe"); !ok || got != "def" {
		t.Fatalf("got %q, %v", got, ok)
	}
	if _, ok := checksumFor(sums, "cdx-darwin-arm64"); ok {
		t.Fatal("found a missing asset")
	}
}

func TestUpdateDownloadsVerifiesAndReplaces(t *testing.T) {
	binary := []byte("new cdx")
	sum := sha256.Sum256(binary)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			http.Redirect(w, r, "/tag/v9.9.9", http.StatusFound)
		case "/download/v9.9.9/checksums.txt":
			w.Write([]byte(hex.EncodeToString(sum[:]) + "  " + updateAsset() + "\n"))
		case "/download/v9.9.9/" + updateAsset():
			w.Write(binary)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	previous := releaseBase
	releaseBase = server.URL
	defer func() { releaseBase = previous }()

	tag, err := latestTag()
	if err != nil || tag != "v9.9.9" {
		t.Fatalf("latestTag = %q, %v", tag, err)
	}
	checksums, err := download(server.URL+"/download/v9.9.9/checksums.txt", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if want, ok := checksumFor(checksums, updateAsset()); !ok || want != hex.EncodeToString(sum[:]) {
		t.Fatalf("checksum %q, %v", want, ok)
	}

	target := filepath.Join(t.TempDir(), "cdx")
	if err := os.WriteFile(target, []byte("old cdx"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceExecutable(target, binary); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(target); string(got) != "new cdx" {
		t.Fatalf("target = %q", got)
	}
}
