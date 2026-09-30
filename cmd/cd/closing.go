package main

import (
	"time"

	"github.com/gorilla/websocket"
)

// closeWait bounds the close handshake after a finished transfer.
const closeWait = 3 * time.Second

// closeGracefully sends a normal WebSocket close frame and waits up to wait
// for the relay's close reply. The reply arrives only after the relay has
// processed every frame written before it, so the last record (COMPLETE) is
// delivered. Dropping the TCP connection right after writing lets the relay
// edge discard that in-flight frame and report `peer-left` instead.
func closeGracefully(connection *websocket.Conn, wait time.Duration) {
	deadline := time.Now().Add(wait)
	message := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done")
	if err := connection.WriteControl(websocket.CloseMessage, message, deadline); err != nil {
		return
	}
	if err := connection.SetReadDeadline(deadline); err != nil {
		return
	}
	for {
		// NextReader discards unread frames and returns an error once the
		// relay's close frame arrives, the socket drops, or the deadline hits.
		if _, _, err := connection.NextReader(); err != nil {
			return
		}
	}
}
