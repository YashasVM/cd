package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func dialTestSocket(t *testing.T, handler func(*websocket.Conn)) *websocket.Conn {
	t.Helper()
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		handler(connection)
	}))
	t.Cleanup(server.Close)
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection
}

func TestCloseGracefullyDeliversLastFrameThenNormalClose(t *testing.T) {
	type observed struct {
		last      string
		closeCode int
	}
	result := make(chan observed, 1)
	connection := dialTestSocket(t, func(server *websocket.Conn) {
		var seen observed
		_, data, err := server.ReadMessage()
		if err == nil {
			seen.last = string(data)
		}
		_, _, err = server.ReadMessage()
		var closeError *websocket.CloseError
		if errors.As(err, &closeError) {
			seen.closeCode = closeError.Code
		}
		result <- seen
	})
	if err := connection.WriteMessage(websocket.BinaryMessage, []byte("complete")); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	closeGracefully(connection, 2*time.Second)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("close handshake took %s; the server replied immediately", elapsed)
	}
	seen := <-result
	if seen.last != "complete" || seen.closeCode != websocket.CloseNormalClosure {
		t.Fatalf("server saw last=%q close=%d, want complete then 1000", seen.last, seen.closeCode)
	}
}

func TestCloseGracefullyGivesUpAfterWait(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	connection := dialTestSocket(t, func(*websocket.Conn) { <-release })
	started := time.Now()
	closeGracefully(connection, 150*time.Millisecond)
	if elapsed := time.Since(started); elapsed < 100*time.Millisecond || elapsed > time.Second {
		t.Fatalf("closeGracefully returned after %s, want about 150ms", elapsed)
	}
}

func TestSenderProgressAcceptsAcksThenMatchingCompletion(t *testing.T) {
	progress := &senderProgress{sent: 3 << 20, chunks: 12}
	if err := progress.handle(kindAck, encodeCounts(4, 1<<20)); err != nil {
		t.Fatal(err)
	}
	if progress.acknowledged != 1<<20 {
		t.Fatalf("acknowledged = %d", progress.acknowledged)
	}
	progress.ended = true
	// Acks may still arrive after END; completion must match exactly.
	if err := progress.handle(kindAck, encodeCounts(12, 3<<20)); err != nil {
		t.Fatal(err)
	}
	if err := progress.handle(kindComplete, encodeCounts(12, 3<<20)); err != nil || !progress.completed {
		t.Fatalf("completion rejected: %v", err)
	}
	if err := progress.handle(kindAck, encodeCounts(12, 3<<20)); err == nil {
		t.Fatal("accepted a record after completion")
	}
}

func TestSenderProgressRejectsInvalidReceiverRecords(t *testing.T) {
	tests := []struct {
		name    string
		ended   bool
		kind    messageKind
		payload []byte
	}{
		{"ack beyond sent", false, kindAck, encodeCounts(4, 2<<20)},
		{"ack with too many chunks", false, kindAck, encodeCounts(5, 1<<10)},
		{"ack going backwards", false, kindAck, encodeCounts(1, 1)},
		{"short ack", false, kindAck, []byte{1, 2, 3}},
		{"completion before end", false, kindComplete, encodeCounts(4, 1<<20)},
		{"completion with wrong bytes", true, kindComplete, encodeCounts(4, 1<<20-1)},
		{"completion with wrong chunks", true, kindComplete, encodeCounts(3, 1<<20)},
		{"sender kind", false, kindChunk, nil},
	}
	for _, test := range tests {
		progress := &senderProgress{sent: 1 << 20, chunks: 4, acknowledged: 2, ended: test.ended}
		if err := progress.handle(test.kind, test.payload); err == nil {
			t.Fatalf("%s: accepted", test.name)
		}
		if progress.completed {
			t.Fatalf("%s: marked completed", test.name)
		}
	}
}
