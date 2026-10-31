//go:build cdprofile

package main

import (
	"encoding/json"
	"os"
	"testing"
)

// TestProfileCLI lets the Go test runner profile the real CLI without a
// production profiling endpoint. It is excluded from normal builds and tests.
func TestProfileCLI(t *testing.T) {
	encoded := os.Getenv("CD_PROFILE_ARGS")
	if encoded == "" {
		t.Skip("set CD_PROFILE_ARGS to a JSON argument array")
	}
	var args []string
	if err := json.Unmarshal([]byte(encoded), &args); err != nil {
		t.Fatal(err)
	}
	if code := run(args); code != 0 {
		t.Fatalf("CLI exited %d", code)
	}
}
