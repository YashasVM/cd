//go:build !windows

package devices

import (
	"os"
	"testing"
)

func exposePrivateTestPath(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}
