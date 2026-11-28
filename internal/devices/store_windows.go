package devices

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func storeUser() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return user.User.Sid, nil
}

func makeStoreDir(path string) error {
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	user, err := storeUser()
	if err != nil {
		return err
	}
	// Protect the directory from parent ACLs and grant the current user
	// inheritable access so credentials are private from the moment of creation.
	sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("O:%sD:P(A;OICI;FA;;;%s)", user, user))
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attrs := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(name, &attrs); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return &os.PathError{Op: "mkdir", Path: path, Err: err}
	}
	return nil
}

func checkStoreDir(root *os.Root, st os.FileInfo) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	opened, err := dir.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(st, opened) {
		return errors.New("device store directory changed during open")
	}
	return checkStoreACL(dir, true)
}

func checkNewCredential(file *os.File) error {
	return checkStoreACL(file, false)
}

func checkCredential(file *os.File, _ os.FileInfo) error {
	return checkStoreACL(file, false)
}

func checkStoreACL(file *os.File, directory bool) error {
	user, err := storeUser()
	if err != nil {
		return err
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	private := errors.New("device store requires a Windows ACL restricted to the current user")
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return private
	}
	// An elevated token can assign ownership of new files to Administrators.
	// The directory itself is always created with the current user as owner.
	if !owner.Equals(user) && (directory || !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid)) {
		return private
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		return private
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil {
		return err
	}
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || !(*windows.SID)(unsafe.Pointer(&ace.SidStart)).Equals(user) {
		return private
	}
	if directory {
		control, _, err := sd.Control()
		if err != nil {
			return err
		}
		const inherit = windows.OBJECT_INHERIT_ACE | windows.CONTAINER_INHERIT_ACE
		if control&windows.SE_DACL_PROTECTED == 0 || ace.Header.AceFlags != inherit {
			return private
		}
	}
	return nil
}

func syncStoreDir(_ *os.Root) error {
	// Windows does not support flushing a directory handle. Save flushes
	// the credential file before renaming it.
	return nil
}
