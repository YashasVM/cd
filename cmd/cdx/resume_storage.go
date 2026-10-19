package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/YashasVM/cd/internal/privatefs"
)

type resumeCapability struct {
	Version     int              `json:"version"`
	Master      string           `json:"master"`
	SenderToken string           `json:"senderToken"`
	Checkpoint  ResumeCheckpoint `json:"checkpoint"`
}

func resumeFailure(message string) error { return NewFailure(failureProtocol, message, retryNever) }

func resumeAtomicJSON(path string, value any) error {
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer root.Close()
	return resumeAtomicJSONRoot(root, filepath.Base(path), value)
}

func resumeAtomicJSONRoot(root *os.Root, name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > 16384 {
		return resumeFailure("resume metadata exceeds 16 KiB")
	}
	temp, temporary, err := privatefs.CreateTempRoot(root, ".cd-resume-*")
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if err = root.Rename(temporary, name); err != nil {
		return err
	}
	return privatefs.SyncRoot(root)
}
func resumeSyncDir(dir string) error { return privatefs.SyncDir(dir) }
func resumeReadJSON(path string, value any) error {
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer root.Close()
	return resumeReadJSONRoot(root, filepath.Base(path), value)
}

func resumeReadJSONRoot(root *os.Root, name string, value any) error {
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 16384 {
		return resumeFailure("resume metadata must be a private regular file of at most 16 KiB")
	}
	file, err := root.Open(name)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, opened) || !opened.Mode().IsRegular() || opened.Size() > 16384 || privatefs.CheckFile(file) != nil {
		return resumeFailure("resume metadata must be an unchanged private regular file of at most 16 KiB")
	}
	// Bound the read even if another process grows the open file after Stat.
	data, err := io.ReadAll(io.LimitReader(file, 16385))
	if err != nil {
		return err
	}
	if len(data) > 16384 {
		return resumeFailure("resume metadata exceeds 16 KiB")
	}
	if err = json.Unmarshal(data, value); err != nil {
		return resumeFailure("resume metadata is corrupt")
	}
	return nil
}
func resumeCapabilityPath(id string) (string, error) {
	if !validTransferID(id) {
		return "", resumeFailure("invalid resumable transfer ID")
	}
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "resume")
	if err = privatefs.MkdirAll(dir); err != nil {
		return "", err
	}
	return filepath.Join(dir, id+".sender.json"), nil
}
func resumeSourceDigest(source shareSource) (string, error) {
	reader, err := source.open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(reader, int64(source.size)+1))
	if err != nil {
		return "", err
	}
	if uint64(size) != source.size {
		return "", resumeFailure("source changed while hashing; choose a new transfer")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func resumeDecode(value string, size int) ([]byte, error) {
	bytes, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(bytes) != size || base64.RawURLEncoding.EncodeToString(bytes) != value {
		return nil, resumeFailure("resume secret or nonce is malformed")
	}
	return bytes, nil
}
func resumeLoadCapability(id string) (resumeCapability, invitation, []byte, error) {
	var cap resumeCapability
	var invite invitation
	path, err := resumeCapabilityPath(id)
	if err != nil {
		return cap, invite, nil, err
	}
	if err = resumeReadJSON(path, &cap); err != nil {
		if os.IsNotExist(err) {
			err = NewFailure(failureNotFound, "local resume capability is unavailable or expired; start a new --resumable transfer", retryNewTransfer, err)
		}
		return cap, invite, nil, err
	}
	master, err := resumeDecode(cap.Master, 32)
	if err != nil {
		return cap, invite, nil, err
	}
	token, err := resumeDecode(cap.SenderToken, 32)
	if err != nil {
		return cap, invite, nil, err
	}
	rawID, err := resumeDecode(id, 16)
	if err != nil {
		return cap, invite, nil, err
	}
	copy(invite.id[:], rawID)
	copy(invite.key[:], master)
	if cap.Version != 2 || cap.Checkpoint.Role != "sender" || cap.Checkpoint.RootID != id {
		return cap, invite, nil, resumeFailure("sender resume identity is inconsistent")
	}
	if err = verifyResumeCheckpoint(cap.Checkpoint, token, time.Now().UnixMilli()); err != nil {
		return cap, invite, nil, err
	}
	return cap, invite, token, nil
}

type resumeDestination struct {
	root           *os.Root
	final          string // authenticated display identity, never used for I/O
	name           string
	checkpointName string
}

// Pin the selected directory for the whole receive, including cancellation and
// publication. Canonical paths alone do not survive directory replacement.
func resumeDest(name, out, id string) (*resumeDestination, error) {
	safe, err := safeFilename(name)
	if err != nil || safe != name {
		return nil, resumeFailure("resumable offer filename is unsafe")
	}
	if !validTransferID(id) {
		return nil, resumeFailure("invalid resumable transfer ID")
	}
	dest := out
	if dest == "" {
		dest = name
	}
	if info, err := os.Stat(dest); err == nil && info.IsDir() {
		dest = filepath.Join(dest, name)
	}
	absolute, err := filepath.Abs(dest)
	if err != nil {
		return nil, err
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	name = filepath.Base(absolute)
	if info, err := root.Lstat(name); err == nil && !info.Mode().IsRegular() {
		root.Close()
		return nil, resumeFailure("resume destination is not a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		root.Close()
		return nil, err
	}
	return &resumeDestination{root: root, final: filepath.Join(dir, name), name: name, checkpointName: ".cd-" + id + ".checkpoint.json"}, nil
}

func validResumeStagingID(name string) bool {
	return filepath.IsLocal(name) && filepath.Base(name) == name && !strings.ContainsAny(name, "/\\") && strings.HasPrefix(name, ".cd-stage-")
}

func resumeStage(root *os.Root, checkpoint ResumeCheckpoint) (*os.File, error) {
	if !validResumeStagingID(checkpoint.StagingID) {
		return nil, resumeFailure("checkpoint staging identity is unsafe")
	}
	info, err := root.Lstat(checkpoint.StagingID)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, resumeFailure("resume staging is not a private regular file")
	}
	file, err := root.OpenFile(checkpoint.StagingID, os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || privatefs.CheckFile(file) != nil {
		file.Close()
		return nil, resumeFailure("resume staging was replaced")
	}
	if opened.Size() < checkpoint.Offset {
		file.Close()
		return nil, resumeFailure("resume staging is truncated")
	}
	hash := sha256.New()
	if _, err = io.CopyN(hash, file, checkpoint.Offset); err != nil {
		file.Close()
		return nil, err
	}
	if hex.EncodeToString(hash.Sum(nil)) != checkpoint.PrefixSHA256 {
		file.Close()
		return nil, resumeFailure("resume staging prefix does not match its authenticated checkpoint")
	}
	if err = file.Truncate(checkpoint.Offset); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func resumeRemove(root *os.Root, checkpoint ResumeCheckpoint, checkpointName string) {
	if validResumeStagingID(checkpoint.StagingID) {
		_ = root.Remove(checkpoint.StagingID)
	}
	_ = root.Remove(checkpointName)
}

// publish never resolves the original directory pathname and never overwrites a
// destination. Entry identity is checked before and after linking. This does not
// make concurrent replacement of entries *within* the pinned directory atomic;
// callers must not treat a writable shared directory as a trusted namespace.
func (dest *resumeDestination) publish(stage *os.File, stagingName string) error {
	info, err := dest.root.Lstat(stagingName)
	if err != nil {
		return err
	}
	opened, err := stage.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !os.SameFile(info, opened) {
		return resumeFailure("resume staging changed before publication")
	}
	finalInfo, finalErr := dest.root.Lstat(dest.name)
	if finalErr == nil {
		if !finalInfo.Mode().IsRegular() || !os.SameFile(finalInfo, opened) {
			return NewFailure(failureExists, "destination appeared during transfer; retained staging was kept", retryNever)
		}
	} else if !errors.Is(finalErr, os.ErrNotExist) {
		return finalErr
	} else if err = dest.root.Link(stagingName, dest.name); err != nil {
		return err
	}
	finalInfo, err = dest.root.Lstat(dest.name)
	if err != nil {
		return err
	}
	if !finalInfo.Mode().IsRegular() || !os.SameFile(finalInfo, opened) {
		// Do not unlink an entry that may now belong to somebody else.
		return resumeFailure("resume destination changed during publication; retained staging was kept")
	}
	return privatefs.SyncRoot(dest.root)
}

func resumeCheckOffer(checkpoint ResumeCheckpoint, offer resumeOffer) error {
	if checkpoint.Filename != offer.Name || checkpoint.Size != offer.SizeValue || checkpoint.WholeSHA256 != offer.WholeSHA256 || checkpoint.ExpiresAt != offer.ExpiresAt {
		return resumeFailure("source identity changed; retained progress cannot be resumed")
	}
	return nil
}

// Bounded cleanup validates the sender MAC before deleting expired secrets.
func resumeCleanupCapabilities(now time.Time) {
	dir, err := stateDir()
	if err != nil {
		return
	}
	dir = filepath.Join(dir, "resume")
	directory, err := os.Open(dir)
	if err != nil {
		return
	}
	defer directory.Close()
	entries, _ := directory.ReadDir(128)
	checked := 0
	for _, entry := range entries {
		if checked >= 128 {
			return
		}
		id, ok := strings.CutSuffix(entry.Name(), ".sender.json")
		if !ok || !validTransferID(id) {
			continue
		}
		checked++
		path := filepath.Join(dir, entry.Name())
		var cap resumeCapability
		if resumeReadJSON(path, &cap) != nil || cap.Version != 2 || cap.Checkpoint.RootID != id || cap.Checkpoint.Role != "sender" || cap.Checkpoint.ExpiresAt > now.UnixMilli() {
			continue
		}
		token, err := resumeDecode(cap.SenderToken, 32)
		if err != nil {
			continue
		}
		if verifyResumeCheckpoint(cap.Checkpoint, token, cap.Checkpoint.ExpiresAt-1) == nil {
			_ = os.Remove(path)
		}
	}
}

func validTransferID(id string) bool {
	bytes, err := base64.RawURLEncoding.DecodeString(id)
	return err == nil && len(bytes) == 16 && base64.RawURLEncoding.EncodeToString(bytes) == id
}
