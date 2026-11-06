package main

import (
	"encoding/json"
	"io"
	"os"
	"testing"
)

func TestTransferTimingIsOptIn(t *testing.T) {
	for _, value := range []string{"", "0", "true"} {
		t.Setenv("CD_TIMING_DEBUG", value)
		if timing := newTransferTiming("receiver"); timing != nil {
			t.Fatalf("enabled timing for %q", value)
		}
	}
	var timing *transferTiming
	timing.mark("disabled")
}

func TestTransferTimingEmitsStructuredPhase(t *testing.T) {
	t.Setenv("CD_TIMING_DEBUG", "1")
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	saved := os.Stderr
	os.Stderr = writer
	defer func() { os.Stderr = saved }()
	newTransferTiming("receiver").mark("first-chunk")
	_ = writer.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatal(err)
	}
	if len(event) != 4 || event["event"] != "transfer-timing" || event["role"] != "receiver" || event["stage"] != "first-chunk" {
		t.Fatalf("unexpected timing event: %s", data)
	}
	if elapsed, ok := event["elapsedMs"].(float64); !ok || elapsed < 0 {
		t.Fatalf("invalid elapsed time: %s", data)
	}
}
