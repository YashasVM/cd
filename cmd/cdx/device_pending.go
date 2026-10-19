package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/YashasVM/cd/internal/privatefs"
)

type devicePending struct {
	Version    int    `json:"version"`
	TransferID string `json:"transferId"`
	ExpiresAt  int64  `json:"expiresAt"`
}

func devicePendingDirectory() (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	dir, err = filepath.Abs(filepath.Join(dir, "device-pending"))
	if err != nil {
		return "", err
	}
	if err = privatefs.MkdirAll(dir); err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || privatefs.Check(dir, info) != nil {
		return "", resumeFailure("pending device transfers require a private directory")
	}
	return dir, nil
}

// Source spelling is normalized exactly as the sender's request paths are.
// Preserve their order and basename: both can affect the generated bundle.
func devicePendingPath(pairID string, files []string) (string, error) {
	if !validTransferID(pairID) || len(files) == 0 {
		return "", resumeFailure("pending device transfer requires a valid pair and source paths")
	}
	paths := make([]string, len(files))
	for i, path := range files {
		if path == "" || path == "-" {
			return "", resumeFailure("pending device transfer requires file or folder paths")
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return "", err
		}
		paths[i] = absolute
	}
	material, err := json.Marshal(struct {
		Version int      `json:"version"`
		PairID  string   `json:"pairId"`
		Files   []string `json:"files"`
	}{1, pairID, paths})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(material)
	dir, err := devicePendingDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, hex.EncodeToString(digest[:])+".json"), nil
}
func validateDevicePendingPath(path string) error {
	dir, err := devicePendingDirectory()
	if err != nil {
		return err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	base := filepath.Base(absolute)
	if filepath.Dir(absolute) != dir || len(base) != 69 || filepath.Ext(base) != ".json" {
		return resumeFailure("invalid pending device transfer path")
	}
	digest, err := hex.DecodeString(base[:64])
	if err != nil || hex.EncodeToString(digest) != base[:64] {
		return resumeFailure("invalid pending device transfer filename")
	}
	return nil
}
func validateDevicePending(record devicePending) error {
	if record.Version != 1 || !validTransferID(record.TransferID) || record.ExpiresAt <= 0 || record.ExpiresAt > 1<<53-1 {
		return resumeFailure("invalid pending device transfer")
	}
	return nil
}

func loadDevicePending(path string) (string, error) {
	if err := validateDevicePendingPath(path); err != nil {
		return "", err
	}
	var record devicePending
	if err := resumeReadJSON(path, &record); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	if err := validateDevicePending(record); err != nil {
		return "", err
	}
	if record.ExpiresAt <= time.Now().UnixMilli() {
		return "", nil
	}
	cap, _, _, err := resumeLoadCapability(record.TransferID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		// resumeLoadCapability rejects an expired checkpoint before checking its
		// MAC. Authenticate that historical checkpoint before treating it as stale.
		if cap.Version == 2 && cap.Checkpoint.Role == "sender" && cap.Checkpoint.RootID == record.TransferID && cap.Checkpoint.ExpiresAt > 0 && cap.Checkpoint.ExpiresAt <= time.Now().UnixMilli() {
			_, masterErr := resumeDecode(cap.Master, 32)
			token, tokenErr := resumeDecode(cap.SenderToken, 32)
			if masterErr == nil && tokenErr == nil && verifyResumeCheckpoint(cap.Checkpoint, token, cap.Checkpoint.ExpiresAt-1) == nil {
				return "", nil
			}
		}
		return "", err
	}
	if cap.Checkpoint.ExpiresAt != record.ExpiresAt {
		return "", resumeFailure("pending device transfer expiry differs from its authenticated capability")
	}
	return record.TransferID, nil
}

func saveDevicePending(path, id string, expiresAt int64) error {
	if err := validateDevicePendingPath(path); err != nil {
		return err
	}
	record := devicePending{1, id, expiresAt}
	if err := validateDevicePending(record); err != nil {
		return err
	}
	if expiresAt <= time.Now().UnixMilli() {
		return resumeFailure("cannot save an expired pending device transfer")
	}
	cap, _, _, err := resumeLoadCapability(id)
	if err != nil {
		return err
	}
	if cap.Checkpoint.ExpiresAt != expiresAt {
		return resumeFailure("pending device transfer expiry differs from its authenticated capability")
	}
	return resumeAtomicJSON(path, record)
}

func resetExhaustedDevicePending(path string) error {
	if err := validateDevicePendingPath(path); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Keep the private capability and receiver checkpoint for inspection/expiry.
	// Only the next command's automatic root selection starts afresh.
	return resumeSyncDir(filepath.Dir(path))
}

// A paired receipt is authoritative only for the saved root and unchanged
// source whose identity was authenticated in its sender capability.
func finishDeviceReceipt(path, id string, files []string) (bool, error) {
	pending, err := loadDevicePending(path)
	if err != nil {
		return false, err
	}
	if pending == "" || pending != id {
		return false, nil
	}
	capability, _, _, err := resumeLoadCapability(id)
	if err != nil {
		return false, err
	}
	source, err := prepareSource(files)
	if err != nil {
		return false, err
	}
	digest, err := resumeSourceDigest(source)
	if err != nil {
		return false, err
	}
	checkpoint := capability.Checkpoint
	if checkpoint.Filename != source.name || checkpoint.Size != int64(source.size) || checkpoint.WholeSHA256 != digest {
		return false, resumeFailure("resume source changed; trusted receipt cannot complete a different source")
	}
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	capabilityPath, err := resumeCapabilityPath(id)
	if err != nil {
		return false, err
	}
	if err = os.Remove(capabilityPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return true, resumeSyncDir(filepath.Dir(path))
}
