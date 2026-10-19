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

func TestTransferProgressPolicy(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		for _, jsonOutput := range []bool{false, true} {
			for _, requested := range []bool{false, true} {
				want := requested || terminal && !jsonOutput
				if got := transferProgressEnabled(terminal, jsonOutput, requested); got != want {
					t.Fatalf("terminal=%v json=%v requested=%v: enabled=%v", terminal, jsonOutput, requested, got)
				}
			}
		}
	}
}

func TestExplicitProgressOutput(t *testing.T) {
	for _, structured := range []bool{false, true} {
		var out bytes.Buffer
		bar := newProgressBar(&out, "sending", 100)
		bar.jsonLines, bar.plainLines = structured, true
		bar.updateAt(10, bar.started)
		bar.updateAt(20, bar.started.Add(10*time.Millisecond))
		bar.updateAt(100, bar.started.Add(20*time.Millisecond))
		bar.finish()
		if strings.Count(out.String(), "\n") != 2 || strings.ContainsAny(out.String(), "\r\x1b") {
			t.Fatalf("unexpected progress %q", out.String())
		}
		if structured && !strings.HasPrefix(out.String(), `{"progress":{"phase":"sending","done":10,"total":100,"bytesPerSecond":0}}`+"\n") {
			t.Fatalf("JSON output %q", out.String())
		}
	}
}

func TestQuietMachineProgressMeasurement(t *testing.T) {
	// Same two observable samples as TestExplicitProgressOutput; old --json
	// enabled progress on pipes without requiring an opt-in flag.
	var before, after bytes.Buffer
	old := newProgressBar(&before, "sending", 100)
	old.jsonLines = true
	old.updateAt(10, old.started)
	old.updateAt(100, old.started.Add(20*time.Millisecond))
	current := newProgressBar(&after, "sending", 100)
	current.jsonLines = true
	if transferProgressEnabled(false, true, false) {
		current.updateAt(10, current.started)
		current.updateAt(100, current.started.Add(20*time.Millisecond))
	}
	if after.Len() != 0 {
		t.Fatalf("default JSON progress = %q", after.String())
	}
	t.Logf("captured JSON progress fixture before: %d bytes/%d lines; after: %d bytes/%d lines", before.Len(), strings.Count(before.String(), "\n"), after.Len(), strings.Count(after.String(), "\n"))
}
