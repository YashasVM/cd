package main

import (
	"context"
	"github.com/gorilla/websocket"
	"testing"
	"time"
)

func TestRelayAdmissionDeadlineDoesNotExpireTransfer(t *testing.T) {
	left, right, _ := relayPair(t)
	if err := left.WriteMessage(websocket.TextMessage, []byte(`{"protocol":"cd-transfer-v1","type":"accepted"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := waitRelayEvent(context.Background(), right, "accepted", 20*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if err := left.WriteMessage(websocket.BinaryMessage, []byte("still transferring")); err != nil {
		t.Fatal(err)
	}
	_, data, err := right.ReadMessage()
	if err != nil || string(data) != "still transferring" {
		t.Fatalf("transfer after admission deadline = %q, %v", data, err)
	}
}
