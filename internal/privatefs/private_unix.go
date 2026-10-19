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

// CheckFile validates the object that is actually open, without resolving its
// original pathname again.
func CheckFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	return Check("", info)
}

func createRoot(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
}

func SyncRoot(root *os.Root) error {
	file, err := root.Open(".")
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
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
