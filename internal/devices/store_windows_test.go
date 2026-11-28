package devices

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func allowEveryoneToRead(t *testing.T, path string) {
	t.Helper()
	user, err := storeUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("D:P(A;OICI;FA;;;%s)(A;;GR;;;WD)", user))
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsStoreRejectsPublicACL(t *testing.T) {
	dir := t.TempDir()
	allowEveryoneToRead(t, dir)
	store := Store{Dir: filepath.Join(dir, "devices")}
	p := testPair(t)
	if err := store.Save("phone", p); err != nil {
		t.Fatalf("create private store under a shared parent: %v", err)
	}
	path := filepath.Join(store.Dir, "phone.json")
	allowEveryoneToRead(t, path)
	if _, err := store.Load("phone"); err == nil {
		t.Fatal("publicly readable credential loaded")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	allowEveryoneToRead(t, store.Dir)
	if _, err := store.List(); err == nil {
		t.Fatal("public store accepted")
	}
	if err := store.Save("phone", p); err == nil {
		t.Fatal("wrote to a public store")
	}
}
