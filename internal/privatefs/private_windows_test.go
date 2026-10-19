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

func TestPrivateWindowsRootCreationIsPrivateBeforeWriting(t *testing.T) {
	dir := t.TempDir()
	// A permissive parent must not leak access into the newly created file.
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
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	file, name, err := CreateTempRoot(root, "secret-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if filepath.Base(name) != name || name == "" {
		t.Fatalf("invalid root-relative name: %q", name)
	}
	if err = CheckFile(file); err != nil {
		t.Fatalf("file was not private at creation: %v", err)
	}
	if _, err = file.WriteString("secret"); err != nil {
		t.Fatal(err)
	}
	if err = file.Sync(); err != nil {
		t.Fatal(err)
	}
	if _, err = file.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	contents := make([]byte, len("secret"))
	if n, err := file.Read(contents); err != nil || n != len(contents) || string(contents) != "secret" {
		t.Fatalf("rooted handle read = %q, %v", contents[:n], err)
	}
	if err = root.Rename(name, "renamed.json"); err != nil {
		t.Fatal(err)
	}
	// Deliberately expose a different object at the old name. CheckFile must
	// inspect the original open handle, not file.Name().
	if err = root.WriteFile(name, []byte("public"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = CheckFile(file); err != nil {
		t.Fatalf("descriptor check followed old pathname: %v", err)
	}
	public, err := root.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer public.Close()
	if CheckFile(public) == nil {
		t.Fatal("descriptor check accepted inherited Everyone access")
	}
	info, err := root.Stat("renamed.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = Check(filepath.Join(dir, "renamed.json"), info); err != nil {
		t.Fatalf("renamed file lost private ACL: %v", err)
	}
}

func TestPrivateWindowsRootCreationTracksRenamedDirectory(t *testing.T) {
	parent := t.TempDir()
	dir, moved := filepath.Join(parent, "chosen"), filepath.Join(parent, "moved")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	outer, err := os.OpenRoot(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer outer.Close()
	// A child Root uses a delete-shareable handle. Top-level os.OpenRoot on
	// Windows instead blocks renaming the directory while the root is open.
	root, err := outer.OpenRoot("chosen")
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err = os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file, name, err := CreateTempRoot(root, "secret-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err = CheckFile(file); err != nil {
		t.Fatal(err)
	}
	if _, err = file.WriteString("secret"); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(moved, name)); err != nil || string(got) != "secret" {
		t.Fatalf("pinned file = %q, %v", got, err)
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Fatalf("modified replacement directory: %v, %v", entries, err)
	}
}
