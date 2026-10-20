package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/YashasVM/cd/internal/devices"
)

func TestDeviceWakeUsesSenderCredentialAndNoTransferData(t *testing.T) {
	var received map[string]any
	var path, method string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, method = r.URL.Path, r.Method
		if r.Header.Get("Content-Type") != "application/json" || json.NewDecoder(r.Body).Decode(&received) != nil {
			t.Error("missing JSON wake request")
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	pair, err := devices.NewPair("Test laptop", strings.Replace(server.URL, "http:", "ws:", 1), nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	requestDeviceWake(context.Background(), pair)
	join, _ := pair.Join(devices.Sender)
	if path != "/api/devices/v1/"+pair.PairID+"/push" || method != http.MethodPost {
		t.Fatalf("incorrect wake endpoint %s %s", method, path)
	}
	if len(received) != 3 || received["v"] != float64(1) || received["token"] != join.Token || received["reason"] != "offer" {
		t.Fatal("wake payload did not contain only the version, sender admission and offer reason")
	}
}

func TestDeviceWakeNeverFollowsCredentialRedirect(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	pair, err := devices.NewPair("Test laptop", strings.Replace(redirect.URL, "http:", "ws:", 1), nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	requestDeviceWake(context.Background(), pair)
	if forwarded.Load() != 0 {
		t.Fatal("redirect received the paired sender credential")
	}
}

func TestDeviceWakeCancellationAndUnsafeOrigins(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { deviceWakeLoop(ctx, devices.Pair{}); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled wake loop kept running")
	}
	for _, endpoint := range []string{"ws://192.168.1.2/ws/devices/v1/id", "http://127.0.0.1/path", "wss://user:password@example.com/path", "wss://example.com/path?token=private"} {
		requestDeviceWake(context.Background(), devices.Pair{RelayURL: endpoint})
	}
}
