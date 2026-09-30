package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gorilla/websocket"
)

// fakeRelay accepts one sender join, records it, and answers `accepted`,
// with a share code when joinCode is set (a current relay) or without one
// (a relay that predates join-time codes). POST /api/codes counts claims.
type fakeRelay struct {
	server   *httptest.Server
	join     chan map[string]string
	claims   atomic.Int32
	joinCode string
}

func newFakeRelay(t *testing.T, joinCode string) *fakeRelay {
	t.Helper()
	relay := &fakeRelay{join: make(chan map[string]string, 1), joinCode: joinCode}
	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/v1/", func(writer http.ResponseWriter, request *http.Request) {
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		var join map[string]string
		if err := connection.ReadJSON(&join); err != nil {
			return
		}
		relay.join <- join
		accepted := map[string]string{"type": "accepted", "protocol": "cd-transfer-v1"}
		if relay.joinCode != "" && join["shareKey"] != "" {
			accepted["code"] = relay.joinCode
		}
		_ = connection.WriteJSON(accepted)
		_, _, _ = connection.ReadMessage() // hold until the client leaves
	})
	mux.HandleFunc("/api/codes", func(writer http.ResponseWriter, request *http.Request) {
		relay.claims.Add(1)
		_ = json.NewEncoder(writer).Encode(codeClaimResponse{Code: "22222"})
	})
	relay.server = httptest.NewServer(mux)
	t.Cleanup(relay.server.Close)
	t.Setenv("CD_RELAY_URL", "ws"+strings.TrimPrefix(relay.server.URL, "http")+"/ws/v1")
	t.Setenv("CD_PUBLIC_URL", relay.server.URL)
	return relay
}

// readyFrom runs a send until it is ready, then cancels it.
func readyFrom(t *testing.T, linkMode bool) readyOutput {
	t.Helper()
	path := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var ready readyOutput
	_ = sendFile(ctx, []string{path}, linkMode, sendHooks{ready: func(value readyOutput) error {
		ready = value
		cancel()
		return nil
	}})
	return ready
}

func TestSendTakesTheCodeFromTheRelayJoin(t *testing.T) {
	relay := newFakeRelay(t, "11111")
	ready := readyFrom(t, false)
	join := <-relay.join
	if !isBase64Url32(join["shareKey"]) {
		t.Fatalf("code-mode join has no share key: %#v", join)
	}
	if ready.Code != "11111" || relay.claims.Load() != 0 {
		t.Fatalf("code = %q with %d POST claims, want the join code and no POST", ready.Code, relay.claims.Load())
	}
}

func TestSendFallsBackToPostOnOlderRelays(t *testing.T) {
	relay := newFakeRelay(t, "")
	ready := readyFrom(t, false)
	<-relay.join
	if ready.Code != "22222" || relay.claims.Load() != 1 {
		t.Fatalf("code = %q with %d POST claims, want the POST fallback", ready.Code, relay.claims.Load())
	}
}

func TestLinkModeNeverSendsTheKey(t *testing.T) {
	relay := newFakeRelay(t, "11111")
	ready := readyFrom(t, true)
	join := <-relay.join
	if _, ok := join["shareKey"]; ok {
		t.Fatalf("link-mode join leaked the key: %#v", join)
	}
	if ready.Code != "" || !strings.Contains(ready.URL, "#v1.") || relay.claims.Load() != 0 {
		t.Fatalf("link ready = %#v with %d claims", ready, relay.claims.Load())
	}
}

func isBase64Url32(value string) bool {
	if len(value) != 43 {
		return false
	}
	for _, character := range value {
		if !(character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' || character == '_') {
			return false
		}
	}
	return true
}
