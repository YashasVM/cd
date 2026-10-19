package privatefs

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestPrivateWindowsACLStorage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	if err := MkdirAll(dir); err != nil {
		t.Fatal(err)
	}
	check := func(path string) {
		t.Helper()
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if err = Check(path, info); err != nil {
			t.Fatal(err)
		}
	}
	check(dir)
	f, err := CreateTemp(dir, "secret-*.json")
	if err != nil {
		t.Fatal(err)
	}
	path := f.Name()
	if _, err = f.WriteString("secret"); err != nil {
		t.Fatal(err)
	}
	if err = f.Sync(); err != nil {
		t.Fatal(err)
	}
	f.Close()
	check(path)
	// A normal Windows file reports 0666; privacy comes from the ACL, not those bits.
	info, _ := os.Stat(path)
	if info.Mode().Perm()&0077 == 0 {
		t.Fatal("expected synthetic Windows permission bits")
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	info, _ = os.Stat(path)
	if Check(path, info) == nil {
		t.Fatal("accepted Everyone access")
	}
}

func TestPrivateWindowsRejectsPublicDirectoryWithoutRepair(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "public")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if MkdirAll(dir) == nil {
		t.Fatal("accepted publicly accessible existing directory")
	}
	info, _ := os.Stat(dir)
	if Check(dir, info) == nil {
		t.Fatal("silently changed existing directory permissions")
	}
}
