package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRetrySetupBoundedAndDeterministic(t *testing.T) {
	for _, test := range []struct {
		name      string
		failUntil int
		kind      string
		retry     string
		want      int
	}{
		{"recover", 2, failureNetwork, retrySameRequest, 3},
		{"exhausted", 9, failureNetwork, retrySameRequest, 3},
		{"permanent", 9, failureProtocol, retryNever, 1},
		{"admitted disconnect", 9, failureDisconnected, retryNewTransfer, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			attempts := 0
			err := retrySetupWith(context.Background(), func() error {
				attempts++
				if attempts <= test.failUntil {
					return NewFailure(test.kind, "opaque", test.retry)
				}
				return nil
			}, func(int) time.Duration { return 0 })
			if attempts != test.want || (err == nil) != (test.failUntil < test.want) {
				t.Fatalf("attempts=%d err=%v", attempts, err)
			}
		})
	}
}
func TestRetrySetupCancellationInterruptsBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	attempts := 0
	err := retrySetupWith(ctx, func() error { attempts++; cancel(); return NewFailure(failureNetwork, "opaque", retrySameRequest) }, func(int) time.Duration { return time.Hour })
	if !errors.Is(err, context.Canceled) || attempts != 1 {
		t.Fatalf("attempts=%d err=%v", attempts, err)
	}
}
func TestDialRelayRetriesOnlyBeforeAdmission(t *testing.T) {
	var calls atomic.Int32
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		connection.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4408, "opaque"))
	}))
	defer server.Close()
	connection, err := dialRelay(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, _, err = connection.ReadMessage()
	if classifyFailure(friendlyRelayError(err)) != failureExpired || calls.Load() != 3 {
		t.Fatalf("calls=%d err=%v", calls.Load(), err)
	}
}
func TestDialRelayRejectsPermanentHTTPWithoutRetry(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusUnauthorized) }))
	defer server.Close()
	_, err := dialRelay(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"))
	if err == nil || calls != 1 || failureGuidance(err) != retryNever {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestSetupDoesNotRetryPermanentDNS(t *testing.T) {
	attempts := 0
	err := retrySetupWith(context.Background(), func() error {
		attempts++
		return &net.DNSError{IsNotFound: true, Err: "opaque", Name: "missing.invalid"}
	}, func(int) time.Duration { return 0 })
	if err == nil || attempts != 1 {
		t.Fatalf("attempts=%d err=%v", attempts, err)
	}
}

func TestDialRelayHonorsCallerDeadlineAcrossSetup(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := dialRelay(ctx, "ws"+strings.TrimPrefix(server.URL, "http"))
	if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 1 || time.Since(started) > time.Second {
		t.Fatalf("calls=%d elapsed=%s err=%v", calls.Load(), time.Since(started), err)
	}
}
