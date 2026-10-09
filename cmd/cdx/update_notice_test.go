package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIsNewerRelease(t *testing.T) {
	for _, test := range []struct {
		latest, current string
		want            bool
	}{
		{"v0.3.4", "v0.3.3", true},
		{"v0.10.0", "v0.9.9", true},
		{"v1.0.0", "v0.99.99", true},
		{"v0.3.4", "v0.3.4", false},
		{"v0.3.4", "v0.4.0", false},
		{"v0.3.4", "v0.3.4-beta.1", true},
		{"v0.3.4", "v0.3.4+build.1", false},
		{"v0.3.4-beta.1", "v0.3.3", false},
		{"v0.3.4", "dev", false},
		{"v0.3.4\x1b[2J", "v0.3.3", false},
		{"v0.03.4", "v0.3.3", false},
	} {
		t.Run(test.latest+"/"+test.current, func(t *testing.T) {
			if got := isNewerRelease(test.latest, test.current); got != test.want {
				t.Fatalf("isNewerRelease(%q, %q) = %v, want %v", test.latest, test.current, got, test.want)
			}
		})
	}
}

func noticeEnvironment(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	directory := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", directory)
	t.Setenv("LOCALAPPDATA", directory)
	t.Setenv("HOME", directory)
	t.Setenv("CD_NO_UPDATE_CHECK", "")
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	previousBase, previousVersion, previousColor := releaseBase, version, colorEnabled
	releaseBase, version, colorEnabled = server.URL, "v0.3.3", false
	t.Cleanup(func() {
		releaseBase, version, colorEnabled = previousBase, previousVersion, previousColor
	})
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(cache, "cdx", "update-check.json")
}

func TestUpdateNoticeChecksCachesAndStopsAfterUpdating(t *testing.T) {
	path := noticeEnvironment(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/tag/v0.3.4", http.StatusFound)
	})
	var output bytes.Buffer
	notifyUpdate([]string{"send", "photo.jpg"}, &output)
	const notice = "  ↑ cdx v0.3.4 available (installed v0.3.3)\n  Run cdx update to update.\n\n"
	if output.String() != notice {
		t.Fatalf("notice = %q", output.String())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var check updateCheck
	if err := json.Unmarshal(data, &check); err != nil || check.Latest != "v0.3.4" || check.CheckedAt.IsZero() {
		t.Fatalf("cached check = %s, error = %v", data, err)
	}
	// A fresh cache must work even when the release server is unreachable.
	releaseBase = "http://127.0.0.1:0"
	output.Reset()
	notifyUpdate([]string{"help"}, &output)
	if output.String() != notice {
		t.Fatalf("cached notice = %q", output.String())
	}
	version = "v0.3.4"
	output.Reset()
	notifyUpdate(nil, &output)
	if output.Len() != 0 {
		t.Fatalf("up-to-date command showed %q", output.String())
	}
}

func TestUpdateNoticeRefreshesStaleCacheAndKeepsNoticeOffline(t *testing.T) {
	path := noticeEnvironment(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/tag/v0.3.5", http.StatusFound)
	})
	saveUpdateCheck(path, updateCheck{CheckedAt: time.Now().Add(-2 * time.Hour), Latest: "v0.3.4"})
	var output bytes.Buffer
	notifyUpdate([]string{"receive", "48291"}, &output)
	const notice = "  ↑ cdx v0.3.5 available (installed v0.3.3)\n  Run cdx update to update.\n\n"
	if output.String() != notice {
		t.Fatalf("refreshed notice = %q", output.String())
	}
	saveUpdateCheck(path, updateCheck{CheckedAt: time.Now().Add(-2 * time.Hour), Latest: "v0.3.5"})
	releaseBase = "http://127.0.0.1:0"
	output.Reset()
	notifyUpdate([]string{"status"}, &output)
	if output.String() != notice {
		t.Fatalf("offline notice = %q", output.String())
	}
}

func TestUpdateNoticeTimeoutIsSilentAndCached(t *testing.T) {
	path := noticeEnvironment(t, func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	var output bytes.Buffer
	start := time.Now()
	notifyUpdate([]string{"help"}, &output)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("slow update check delayed command by %s", elapsed)
	}
	if output.Len() != 0 {
		t.Fatalf("failed check showed %q", output.String())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var check updateCheck
	if err := json.Unmarshal(data, &check); err != nil || check.CheckedAt.IsZero() {
		t.Fatalf("failed check was not cached: %s, %v", data, err)
	}
	start = time.Now()
	notifyUpdate([]string{"help"}, &output)
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("failed check was retried immediately: %s", elapsed)
	}
}

func TestUpdateNoticeSkipsExplicitUpdateInternalAndDevelopmentCommands(t *testing.T) {
	noticeEnvironment(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/tag/v0.3.4", http.StatusFound)
	})
	for _, command := range []string{"update", "--update", "upgrade", holderCommand} {
		var output bytes.Buffer
		notifyUpdate([]string{command}, &output)
		if output.Len() != 0 {
			t.Fatalf("%s showed %q", command, output.String())
		}
	}
	var output bytes.Buffer
	t.Setenv("CD_NO_UPDATE_CHECK", "1")
	notifyUpdate([]string{"help"}, &output)
	if output.Len() != 0 {
		t.Fatalf("opt-out showed %q", output.String())
	}
	t.Setenv("CD_NO_UPDATE_CHECK", "")
	version = "dev"
	notifyUpdate([]string{"help"}, &output)
	if output.Len() != 0 {
		t.Fatalf("development build showed %q", output.String())
	}
	version = "v0.3.3"
	notifyUpdate([]string{"help"}, &output)
	if output.String() != "  ↑ cdx v0.3.4 available (installed v0.3.3)\n  Run cdx update to update.\n\n" {
		t.Fatalf("release build showed %q", output.String())
	}
}
