package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestProgressBarLine(t *testing.T) {
	var out bytes.Buffer
	bar := newProgressBar(&out, "sending", 4<<20)
	start := bar.started
	bar.updateAt(1<<20, start.Add(time.Second))
	line := bar.line(1<<20, start.Add(time.Second))
	for _, want := range []string{"sending [██████░░░", " 25%", "1.0 MiB / 4.0 MiB", "1.0 MiB/s", "ETA 0:03"} {
		if !strings.Contains(line, want) {
			t.Fatalf("line %q missing %q", line, want)
		}
	}
	if done := bar.line(4<<20, start.Add(2*time.Second)); !strings.Contains(done, "100%") || !strings.Contains(done, "in 0:02") {
		t.Fatalf("final line = %q", done)
	}
}

func TestProgressBarThrottles(t *testing.T) {
	var out bytes.Buffer
	bar := newProgressBar(&out, "receiving", 100)
	now := bar.started
	bar.updateAt(10, now)
	bar.updateAt(20, now.Add(10*time.Millisecond))
	bar.updateAt(100, now.Add(20*time.Millisecond))
	if got := strings.Count(out.String(), "\r"); got != 2 {
		t.Fatalf("drew %d times, want 2 (first and final)", got)
	}
	bar.finish()
	if !strings.HasSuffix(out.String(), "\n") {
		t.Fatal("finish did not end the line")
	}
}
