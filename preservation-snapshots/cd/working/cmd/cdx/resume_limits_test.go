package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestResumeSessionLimitStopsRetryForEventAndClose(t *testing.T) {
	for _, mode := range []string{"event", "close"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				socket, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer socket.Close()
				if _, _, err := socket.ReadMessage(); err != nil {
					return
				}
				if mode == "event" {
					_ = socket.WriteJSON(resumeEvent{Type: "exhausted", Protocol: resumeProtocol, Reason: "session_limit"})
				} else {
					_ = socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4410, "transfer session limit reached"), time.Now().Add(time.Second))
				}
			}))
			defer server.Close()
			t.Setenv("CD_RELAY_URL", strings.Replace(server.URL, "http:", "ws:", 1)+"/ws/v1")
			t.Setenv("CD_PUBLIC_URL", server.URL)
			_, err := resumeConnect(context.Background(), testInvitation(), "sender", make([]byte, 32))
			if !errors.Is(err, errResumeSessionLimit) || classifyFailure(err) != failureExpired || failureGuidance(err) != retryNewTransfer {
				t.Fatalf("session exhaustion should require a new transfer: %v", err)
			}
		})
	}
}

func TestExhaustedDeviceCommandKeepsCapabilityButStartsFreshOnRerun(t *testing.T) {
	capability, retained, pending := pendingCapabilityFixture(t)
	if err := saveDevicePending(pending, capability.Checkpoint.RootID, capability.Checkpoint.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	if err := resetExhaustedDevicePending(pending); err != nil {
		t.Fatal(err)
	}
	if id, err := loadDevicePending(pending); err != nil || id != "" {
		t.Fatalf("next command should select a new root: %q %v", id, err)
	}
	if _, err := os.Stat(retained); err != nil {
		t.Fatalf("session exhaustion removed the private capability: %v", err)
	}
	if _, _, _, err := resumeLoadCapability(capability.Checkpoint.RootID); err != nil {
		t.Fatalf("retained capability no longer authenticates: %v", err)
	}
}
