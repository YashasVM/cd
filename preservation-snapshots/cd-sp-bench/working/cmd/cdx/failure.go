package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Failure kinds are stable strings for scripts and agents; the message is
// for people and may change.
const (
	failureCanceled     = "canceled"
	failureInvalidCode  = "invalid_code"
	failureNotFound     = "not_found"
	failureExpired      = "expired"
	failureClaimed      = "claimed"
	failureExists       = "exists"
	failureBusy         = "busy"
	failureStalled      = "stalled"
	failureDisconnected = "disconnected"
	failureNetwork      = "network"
	failureLocal        = "local_file"
	failureProtocol     = "protocol"
	failureTimeout      = "timeout"
	failureOther        = "failed"
)

// classifyFailure maps an error to a failure kind by its wording, which is
// owned by this package.
func classifyFailure(err error) string {
	if errors.Is(err, context.Canceled) {
		return failureCanceled
	}
	message := strings.ToLower(err.Error())
	has := func(parts ...string) bool {
		for _, part := range parts {
			if strings.Contains(message, part) {
				return true
			}
		}
		return false
	}
	switch {
	case has("code is invalid", "link is invalid", "is not a share code"):
		return failureInvalidCode
	case has("bad code", "no transfer "):
		return failureNotFound
	case has("already claimed"):
		return failureClaimed
	case has("expired", "within 15m", "within 10m"):
		return failureExpired
	case has("already exists"):
		return failureExists
	case has("busy", "too many attempts"):
		return failureBusy
	case has("stalled", "too slow", "within 90s"):
		return failureStalled
	case has("disconnected", "no longer available"):
		return failureDisconnected
	case has("cannot find", "cannot read", "cannot access", "cannot open", "cannot write", "cannot share",
		"is a folder", "not a regular file", "changed while", "write file"):
		return failureLocal
	case has("connect to cd relay", "did not answer", "network"):
		return failureNetwork
	case has("invalid", "unsafe", "protocol", "update cdx", "out of order", "unexpected"):
		return failureProtocol
	}
	return failureOther
}

type failureOutput struct {
	Version int `json:"version"`
	Error   struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"error"`
}

// reportFailure prints err for people on stderr and, with --json, as one
// {"version","error":{"kind","message"}} object on stdout.
func reportFailure(stdout, stderr io.Writer, err error, jsonOutput bool) {
	message := strings.TrimSpace(strings.TrimPrefix(err.Error(), "cdx: "))
	kind := classifyFailure(err)
	if kind == failureCanceled {
		message = "transfer canceled"
	}
	fmt.Fprintln(stderr, "cdx:", message)
	if jsonOutput {
		var value failureOutput
		value.Version = 1
		value.Error.Kind = kind
		value.Error.Message = message
		_ = json.NewEncoder(stdout).Encode(value)
	}
}
