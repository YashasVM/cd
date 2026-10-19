package privatefs

import (
	"os"
	"testing"
)

func TestCreateTempRootRejectsUnsafePatterns(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, pattern := range []string{"", "../escape", "sub/file", `sub\file`, "stream:secret"} {
		if file, _, err := CreateTempRoot(root, pattern); err == nil {
			file.Close()
			t.Errorf("accepted unsafe pattern %q", pattern)
		}
	}
}
