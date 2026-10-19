package devices

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/YashasVM/cd/internal/privatefs"
)

const maxStoreFile = 32768
const maxDevices = 256

type Store struct{ Dir string }
type DeviceSummary struct {
	Name       string `json:"name"`
	PairID     string `json:"pairId"`
	DeviceName string `json:"deviceName"`
}
type storedDevice struct {
	Name string `json:"name"`
	Pair Pair   `json:"pair"`
}

func validName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}
func (s Store) directory() (*os.Root, error) {
	if s.Dir == "" {
		return nil, errors.New("device store directory missing")
	}
	if err := privatefs.MkdirAll(s.Dir); err != nil {
		return nil, err
	}
	st, err := os.Lstat(s.Dir)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || privatefs.Check(s.Dir, st) != nil {
		return nil, errors.New("device store must be a private directory")
	}
	return os.OpenRoot(s.Dir)
}
func (s Store) Save(name string, p Pair) error {
	if !validName(name) {
		return errors.New("device name must contain only letters, numbers, dash or underscore")
	}
	if err := p.Validate(); err != nil {
		return err
	}
	root, err := s.directory()
	if err != nil {
		return err
	}
	defer root.Close()
	directoryReader, err := root.Open(".")
	if err != nil {
		return err
	}
	entries, err := directoryReader.ReadDir(maxDevices*2 + 1)
	directoryReader.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if len(entries) > maxDevices*2 {
		return errors.New("too many device store entries")
	}
	count := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			count++
		}
	}
	if _, err := root.Stat(name + ".json"); errors.Is(err, os.ErrNotExist) && count >= maxDevices {
		return errors.New("device store full")
	}
	data, err := json.Marshal(storedDevice{name, p})
	if err != nil {
		return err
	}
	if len(data) > maxStoreFile {
		return errors.New("device credential too large")
	}
	id, err := randomID(16)
	if err != nil {
		return err
	}
	temporary := ".tmp-" + id
	f, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	// Validate inherited permissions before any credential bytes are written.
	info, checkErr := f.Stat()
	if checkErr == nil {
		checkErr = privatefs.Check(filepath.Join(root.Name(), temporary), info)
	}
	if checkErr != nil {
		f.Close()
		return checkErr
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = root.Rename(temporary, name+".json"); err != nil {
		return err
	}
	return privatefs.SyncDir(s.Dir)
}
func (s Store) Load(name string) (Pair, error) {
	if !validName(name) {
		return Pair{}, errors.New("invalid device name")
	}
	root, err := s.directory()
	if err != nil {
		return Pair{}, err
	}
	defer root.Close()
	return load(root, name)
}
func load(root *os.Root, name string) (Pair, error) {
	st, err := root.Lstat(name + ".json")
	if err != nil {
		return Pair{}, err
	}
	if !st.Mode().IsRegular() || privatefs.Check(filepath.Join(root.Name(), name+".json"), st) != nil || st.Size() > maxStoreFile {
		return Pair{}, errors.New("credential must be a bounded private regular file")
	}
	f, err := root.Open(name + ".json")
	if err != nil {
		return Pair{}, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return Pair{}, err
	}
	if !os.SameFile(st, opened) {
		return Pair{}, errors.New("credential changed during read")
	}
	b, err := io.ReadAll(io.LimitReader(f, maxStoreFile+1))
	if err != nil {
		return Pair{}, err
	}
	if len(b) > maxStoreFile {
		return Pair{}, errors.New("credential too large")
	}
	var device storedDevice
	if err = json.Unmarshal(b, &device); err != nil {
		return Pair{}, err
	}
	if device.Name != name {
		return Pair{}, errors.New("credential name mismatch")
	}
	return device.Pair, device.Pair.Validate()
}
func (s Store) List() ([]DeviceSummary, error) {
	root, err := s.directory()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(maxDevices*2 + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > maxDevices*2 {
		return nil, errors.New("too many device store entries")
	}
	out := []DeviceSummary{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".json")
		if !validName(name) {
			return nil, fmt.Errorf("invalid credential filename %q", entry.Name())
		}
		p, err := load(root, name)
		if err != nil {
			return nil, fmt.Errorf("device %s: %w", name, err)
		}
		out = append(out, DeviceSummary{name, p.PairID, p.Name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
func (s Store) Forget(name string) error {
	if !validName(name) {
		return errors.New("invalid device name")
	}
	root, err := s.directory()
	if err != nil {
		return err
	}
	defer root.Close()
	err = root.Remove(filepath.Base(name) + ".json")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
