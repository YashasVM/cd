package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
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

const (
	retryNever       = "never"
	retrySameRequest = "same_request"
	retryNewTransfer = "new_transfer"
)

// Failure keeps machine contracts independent of human wording.
type Failure struct {
	Kind    string
	Message string
	Retry   string
	Cause   error
}

func (f *Failure) Error() string { return f.Message }
func (f *Failure) Unwrap() error { return f.Cause }
func NewFailure(kind, message, retry string, cause ...error) *Failure {
	f := &Failure{Kind: kind, Message: message, Retry: retry}
	if len(cause) > 0 {
		f.Cause = cause[0]
	}
	return f
}
func failuref(kind, retry, format string, args ...any) error {
	cause := fmt.Errorf(format, args...)
	return NewFailure(kind, cause.Error(), retry, cause)
}
func classifyFailure(err error) string {
	if errors.Is(err, context.Canceled) {
		return failureCanceled
	}
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Kind
	}
	if errors.Is(err, fs.ErrExist) {
		return failureExists
	}
	var path *fs.PathError
	if errors.As(err, &path) {
		return failureLocal
	}
	var network net.Error
	if errors.As(err, &network) || errors.Is(err, context.DeadlineExceeded) {
		return failureNetwork
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
func failureGuidance(err error) string {
	if errors.Is(err, context.Canceled) {
		return retryNever
	}
	var failure *Failure
	if errors.As(err, &failure) && failure.Retry != "" {
		return failure.Retry
	}
	switch classifyFailure(err) {
	case failureNetwork, failureBusy:
		return retrySameRequest
	case failureExpired, failureDisconnected, failureStalled:
		return retryNewTransfer
	default:
		return retryNever
	}
}

type failureOutput struct {
	Version int `json:"version"`
	Error   struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
		Retry   string `json:"retry"`
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
		value.Error.Retry = failureGuidance(err)
		_ = json.NewEncoder(stdout).Encode(value)
	}
}
