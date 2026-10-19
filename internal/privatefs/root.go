package privatefs

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
)

// CreateTempRoot atomically creates a private file within the already-open
// directory, including on Windows where mode 0600 does not establish a DACL.
// Its returned name is a single component suitable for subsequent root methods.
// Never reopen file.Name(): the original directory pathname may have changed.
func CreateTempRoot(root *os.Root, pattern string) (*os.File, string, error) {
	if !filepath.IsLocal(pattern) || strings.ContainsAny(pattern, `/\\:`) {
		return nil, "", &os.PathError{Op: "createtemp", Path: pattern, Err: os.ErrInvalid}
	}
	for attempts := 0; attempts < 100; attempts++ {
		name := pattern
		if i := strings.LastIndex(name, "*"); i >= 0 {
			name = name[:i] + rand.Text() + name[i+1:]
		} else {
			name += rand.Text()
		}
		file, err := createRoot(root, name)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return nil, "", err
		}
		return file, name, nil
	}
	return nil, "", os.ErrExist
}
