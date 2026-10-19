package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"testing"
)

func TestDeviceRetryRejectsPermanentErrors(t *testing.T) {
	for _, err := range []error{errors.New("source changed"), io.EOF, io.ErrUnexpectedEOF, &url.Error{Op: "parse", URL: "invalid", Err: errors.New("unsupported scheme")}, &os.PathError{Op: "open", Path: "missing", Err: os.ErrNotExist}, os.ErrPermission, context.Canceled, resumeFailure("bad checkpoint"), NewFailure(failureNetwork, "permanent", retryNever)} {
		if retryDeviceTransfer(err) {
			t.Errorf("retried permanent error: %v", err)
		}
	}
	for _, err := range []error{NewFailure(failureDisconnected, "interrupted", retrySameRequest), NewFailure(failureTimeout, "timeout", retrySameRequest), &net.OpError{Op: "read", Net: "tcp", Err: io.EOF}} {
		if !retryDeviceTransfer(err) {
			t.Errorf("did not retry transport error: %v", err)
		}
	}
}
func TestRecordLinkCancellationWinsQueuedError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 100; i++ {
		link := &recordLink{items: make(chan linkItem, 1), pending: map[uint32][]byte{}}
		link.items <- linkItem{err: errors.New("closed network connection")}
		if _, _, err := link.next(ctx, 0); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost to queued error: %v", err)
		}
	}
}
