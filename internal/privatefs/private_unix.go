//go:build !windows

// Package privatefs enforces private storage using native platform permissions.
package privatefs

import "os"

func Check(path string, info os.FileInfo) error {
	if info.Mode().Perm()&0077 != 0 {
		return os.ErrPermission
	}
	return nil
}
func MkdirAll(path string) error                       { return os.MkdirAll(path, 0700) }
func CreateTemp(dir, pattern string) (*os.File, error) { return os.CreateTemp(dir, pattern) }
func SyncDir(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
