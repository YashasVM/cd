package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestClassifyFailure(t *testing.T) {
	cases := map[string]error{
		failureCanceled: fmt.Errorf("wrapped: %w", context.Canceled),
	}
	for _, kind := range []string{failureNotFound, failureExpired, failureClaimed, failureExists, failureStalled, failureDisconnected, failureLocal, failureInvalidCode, failureBusy, failureProtocol} {
		cases[kind] = fmt.Errorf("outer: %w", NewFailure(kind, "opaque wording", retryNever))
	}

	for want, err := range cases {
		if got := classifyFailure(err); got != want {
			t.Errorf("classifyFailure(%q) = %q, want %q", err, got, want)
		}
	}
}

func TestReportFailureJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	reportFailure(&stdout, &stderr, NewFailure(failureNotFound, "cdx: bad code, or the sender is no longer available", retryNever), true)
	var value failureOutput
	if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
		t.Fatalf("stdout %q is not JSON: %v", stdout.String(), err)
	}
	if value.Error.Kind != failureNotFound || strings.HasPrefix(value.Error.Message, "cdx:") {
		t.Fatalf("got %+v", value)
	}
	if !strings.HasPrefix(stderr.String(), "cdx: bad code") {
		t.Fatalf("stderr = %q", stderr.String())
	}
	stdout.Reset()
	reportFailure(&stdout, &stderr, errors.New("boom"), false)
	if stdout.Len() != 0 {
		t.Fatal("plain mode wrote to stdout")
	}
}

func TestParseStateArgsTimeout(t *testing.T) {
	jsonOutput, timeout, rest, err := parseStateArgs([]string{"--timeout", "90s", "--json", "48291"})
	if err != nil || !jsonOutput || timeout != 90*time.Second || len(rest) != 1 {
		t.Fatalf("got %v %v %v %v", jsonOutput, timeout, rest, err)
	}
	if _, timeout, _, _ := parseStateArgs([]string{"--timeout=2m", "1"}); timeout != 2*time.Minute {
		t.Fatalf("timeout = %v", timeout)
	}
	for _, bad := range [][]string{{"--timeout"}, {"--timeout", "soon"}, {"--timeout=-1s"}} {
		if _, _, _, err := parseStateArgs(bad); err == nil {
			t.Fatalf("%v: expected an error", bad)
		}
	}
}

func TestProgressBarJSONLines(t *testing.T) {
	var out bytes.Buffer
	bar := newProgressBar(&out, "receiving", 100)
	bar.jsonLines = true
	now := bar.started
	bar.updateAt(50, now.Add(500*time.Millisecond))
	bar.updateAt(60, now.Add(600*time.Millisecond))
	bar.updateAt(100, now.Add(700*time.Millisecond))
	bar.finish()
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines: %q", len(lines), out.String())
	}
	var last progressLine
	if err := json.Unmarshal([]byte(lines[1]), &last); err != nil || last.Progress.Done != 100 || last.Progress.Phase != "receiving" {
		t.Fatalf("last line %q: %v", lines[1], err)
	}
}

func TestFailureGuidanceSurvivesWrappingAndJSON(t *testing.T) {
	cause := errors.New("original")
	err := fmt.Errorf("outer: %w", NewFailure(failureBusy, "opaque", retrySameRequest, cause))
	if classifyFailure(err) != failureBusy || failureGuidance(err) != retrySameRequest || !errors.Is(err, cause) {
		t.Fatal("typed contract lost through wrap")
	}
	var stdout, stderr bytes.Buffer
	reportFailure(&stdout, &stderr, err, true)
	var value failureOutput
	if json.Unmarshal(stdout.Bytes(), &value) != nil || value.Error.Retry != retrySameRequest {
		t.Fatalf("JSON %s", stdout.String())
	}
	if strings.Count(stdout.String(), "\n") != 1 {
		t.Fatal("failure result is not compact")
	}
}
func TestClassificationDoesNotMatchMessages(t *testing.T) {
	for _, message := range []string{"network disconnected expired", "cannot find invalid code already exists"} {
		if got := classifyFailure(errors.New(message)); got != failureOther {
			t.Fatalf("wording classified as %s", got)
		}
	}
}
