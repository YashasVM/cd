//go:build !windows

package devices

import (
	"errors"
	"os"
)

func makeStoreDir(path string) error {
	return os.MkdirAll(path, 0700)
}

func checkStoreDir(_ *os.Root, st os.FileInfo) error {
	if st.Mode().Perm()&0077 != 0 {
		return errors.New("device store must be a private directory with mode 0700")
	}
	return nil
}

func checkNewCredential(_ *os.File) error {
	return nil // The temporary file was created exclusively with mode 0600.
}

func checkCredential(_ *os.File, st os.FileInfo) error {
	if st.Mode().Perm()&0077 != 0 {
		return errors.New("credential must be a bounded private regular file")
	}
	return nil
}

func syncStoreDir(root *os.Root) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
