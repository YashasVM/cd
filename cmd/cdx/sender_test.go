package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestEndpointBaseRejectsUnsafeOverrides(t *testing.T) {
	t.Setenv("CD_RELAY_URL", "https://example.com/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "https://cd.yash0.in")
	if _, _, err := endpointBase(); err == nil {
		t.Fatal("accepted an HTTP relay URL")
	}

	t.Setenv("CD_RELAY_URL", "wss://cd.yash0.in/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "https://example.com/prefix")
	if _, _, err := endpointBase(); err == nil {
		t.Fatal("accepted a public URL with a path prefix")
	}
}

func TestEndpointBaseRejectsInsecureRemoteAndCredentials(t *testing.T) {
	tests := []struct{ relay, public string }{
		{"ws://example.com/ws/v1", "https://cd.yash0.in"},
		{"wss://user:pass@example.com/ws/v1", "https://cd.yash0.in"},
		{"wss://cd.yash0.in/ws/v1", "http://example.com"},
		{"wss://cd.yash0.in/ws/v1", "https://user:pass@example.com"},
	}
	for _, test := range tests {
		t.Setenv("CD_RELAY_URL", test.relay)
		t.Setenv("CD_PUBLIC_URL", test.public)
		if _, _, err := endpointBase(); err == nil {
			t.Fatalf("accepted relay=%q public=%q", test.relay, test.public)
		}
	}
}

func TestEndpointBaseAllowsInsecureLoopbackForDevelopment(t *testing.T) {
	t.Setenv("CD_RELAY_URL", "ws://127.0.0.1:8787/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "http://127.0.0.1:8787")
	if _, _, err := endpointBase(); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointBaseRejectsOriginsThatCannotServeTheInvitation(t *testing.T) {
	tests := []struct{ relay, public string }{
		{"wss://relay.example.com/ws/v1", "https://download.example.com"},
		{"wss://cd.yash0.in/ws/v1", "http://cd.yash0.in"},
		{"ws://127.0.0.1:8787/ws/v1", "http://127.0.0.1:4173"},
		{"wss://cd.yash0.in/wrong", "https://cd.yash0.in"},
		{"wss://cd.yash0.in", "https://cd.yash0.in"},
	}
	for _, test := range tests {
		t.Setenv("CD_RELAY_URL", test.relay)
		t.Setenv("CD_PUBLIC_URL", test.public)
		if _, _, err := endpointBase(); err == nil {
			t.Fatalf("accepted relay=%q public=%q", test.relay, test.public)
		}
	}
}

func TestSafeFilenameMatchesBrowserContract(t *testing.T) {
	valid, err := safeFilename("some/path/résumé final.pdf")
	if err != nil || valid != "résumé final.pdf" {
		t.Fatalf("safe filename = %q, %v", valid, err)
	}
	if base, err := safeFilename("some/dir/name.txt"); err != nil || base != "name.txt" {
		t.Fatalf("basename extraction = %q, %v", base, err)
	}
	for _, name := range []string{"bad\\name.txt", "line\nbreak.txt", "..", ".", "/"} {
		if _, err := safeFilename(name); err == nil {
			t.Fatalf("accepted unsafe filename %q", name)
		}
	}
}

func TestOpenSharedFileNamesPathOnce(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-file.bin")
	_, _, err := openSharedFile(missing)
	if err == nil {
		t.Fatal("opened a missing file")
	}
	if count := strings.Count(err.Error(), missing); count != 1 {
		t.Fatalf("path named %d times in %q", count, err.Error())
	}
}

func TestOpenSharedFileRejectsDirectoriesAndDevices(t *testing.T) {
	if _, _, err := openSharedFile(t.TempDir()); err == nil {
		t.Fatal("opened a directory")
	}
	if _, _, err := openSharedFile("/dev/null"); err == nil {
		t.Fatal("opened a device")
	}
	if _, _, err := openSharedFile("-"); err == nil {
		t.Fatal("opened stdin")
	}
}

func TestOpenSharedFileAcceptsRegularFilesAndSymlinks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "real.bin")
	if err := os.WriteFile(path, []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.bin")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	file, info, err := openSharedFile(link)
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if info.Size() != 2 {
		t.Fatalf("symlink size = %d", info.Size())
	}
}

func TestFileMediaTypeStripsCharsetParameters(t *testing.T) {
	if got := fileMediaType("notes.txt"); got != "text/plain" {
		t.Fatalf("text media type = %q", got)
	}
	if got := fileMediaType("photo.JPG"); got == "" || strings.Contains(got, ";") {
		t.Fatalf("image media type = %q", got)
	}
	if got := fileMediaType("no-extension"); got != "application/octet-stream" {
		t.Fatalf("fallback media type = %q", got)
	}
}

func TestFormatBytesStaysReadable(t *testing.T) {
	if got := formatBytes(0); got != "0 bytes" {
		t.Fatalf("zero = %q", got)
	}
	if got := formatBytes(1); got != "1 byte" {
		t.Fatalf("one = %q", got)
	}
	if got := formatBytes(5 * 1024 * 1024); !strings.Contains(got, "MiB") || !strings.Contains(got, "(5242880 bytes)") {
		t.Fatalf("mebibytes = %q", got)
	}
	if got := formatShortBytes(2048); got != "2.0 KiB" {
		t.Fatalf("short = %q", got)
	}
}

func TestFriendlyRelayErrorExplainsCloseCodes(t *testing.T) {
	cases := map[int]string{
		4408: "expired",
		4409: "claimed",
		4404: "no longer available",
		4406: "protocol",
	}
	for code, fragment := range cases {
		err := friendlyRelayError(&websocket.CloseError{Code: code, Text: "test"})
		if err == nil || !strings.Contains(err.Error(), fragment) {
			t.Fatalf("code %d = %v", code, err)
		}
	}
	other := errors.New("boom")
	if friendlyRelayError(other) != other {
		t.Fatal("non-close error was rewritten")
	}
}
