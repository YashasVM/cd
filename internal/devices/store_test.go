package devices

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStorePrivateAtomicAndPublicListing(t *testing.T) {
	store := Store{Dir: filepath.Join(t.TempDir(), "devices")}
	p := testPair(t)
	if err := store.Save("phone", p); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load("phone")
	if err != nil || got.Secret != p.Secret {
		t.Fatalf("load failed: %v", err)
	}
	for path, mode := range map[string]os.FileMode{store.Dir: 0700, filepath.Join(store.Dir, "phone.json"): 0600} {
		st, err := os.Stat(path)
		if err != nil || st.Mode().Perm() != mode {
			t.Fatalf("private mode %s: %v %v", path, st, err)
		}
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(list)
	if strings.Contains(string(b), p.Secret) || strings.Contains(string(b), "secret") {
		t.Fatal("listing leaked credential")
	}
	if len(list) != 1 || list[0].Name != "phone" {
		t.Fatalf("wrong listing: %s", b)
	}
	p.Name = "renamed laptop"
	if err = store.Save("phone", p); err != nil {
		t.Fatal(err)
	}
	got, err = store.Load("phone")
	if err != nil || got.Name != p.Name {
		t.Fatal("atomic replacement failed")
	}
	entries, _ := os.ReadDir(store.Dir)
	if len(entries) != 1 {
		t.Fatal("temporary credential leaked")
	}
	if err = store.Forget("phone"); err != nil {
		t.Fatal(err)
	}
	if err = store.Forget("phone"); err != nil {
		t.Fatal("forget not idempotent")
	}
	if _, err = store.Load("phone"); !os.IsNotExist(err) {
		t.Fatalf("forgotten credential loaded: %v", err)
	}
}
func TestStoreRejectsUnsafeEntries(t *testing.T) {
	store := Store{Dir: filepath.Join(t.TempDir(), "devices")}
	p := testPair(t)
	for _, name := range []string{"../escape", ".", "", "two words", "a/b"} {
		if store.Save(name, p) == nil {
			t.Errorf("unsafe name accepted: %q", name)
		}
	}
	if err := store.Save("phone", p); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.Dir, "phone.json")
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load("phone"); err == nil {
		t.Fatal("publicly readable credential loaded")
	}
	os.Remove(path)
	outside := filepath.Join(t.TempDir(), "credential")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load("phone"); err == nil {
		t.Fatal("symlink credential loaded")
	}
	os.Remove(path)
	if err := os.WriteFile(path, make([]byte, maxStoreFile+1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load("phone"); err == nil {
		t.Fatal("oversized credential loaded")
	}
	if err := os.Chmod(store.Dir, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load("phone"); err == nil {
		t.Fatal("public store accepted")
	}
}
