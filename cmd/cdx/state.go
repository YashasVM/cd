package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var stateWrites sync.Mutex
var stateKeyPattern = regexp.MustCompile(`^(\d{4,5}|[A-Za-z0-9_-]{22})$`)
var stateCodePattern = regexp.MustCompile(`^\d{4,5}$`)
var stateLogPattern = regexp.MustCompile(`^send-[a-f0-9]{12}\.log$`)

func (state transferState) key() string { return state.TransferID }

func stateDir() (string, error) {
	if dir := os.Getenv("CD_STATE_DIR"); dir != "" {
		return dir, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("find a cache directory for transfer state: %w", err)
	}
	return filepath.Join(cache, "cdx", "transfers"), nil
}

func validTransferID(id string) bool {
	bytes, err := base64.RawURLEncoding.DecodeString(id)
	return err == nil && len(bytes) == 16 && base64.RawURLEncoding.EncodeToString(bytes) == id
}

func stateKeyFromInput(input string) (string, error) {
	input = strings.TrimSpace(input)
	if stateCodePattern.MatchString(input) || validTransferID(input) {
		return input, nil
	}
	if parsed, err := url.Parse(input); err == nil {
		if id := strings.TrimPrefix(parsed.Path, "/s/"); id != parsed.Path && validTransferID(id) {
			return id, nil
		}
	}
	return "", NewFailure(failureInvalidCode, fmt.Sprintf("%q is not a share code, transfer ID, or link", input), retryNever)
}

func validateState(state transferState) error {
	if state.Version != 1 || !validTransferID(state.TransferID) {
		return errors.New("unsupported version or invalid transfer ID")
	}
	if state.Code != "" && !stateCodePattern.MatchString(state.Code) {
		return errors.New("invalid share code")
	}
	if name, err := safeFilename(state.Filename); err != nil || name != state.Filename {
		return errors.New("invalid filename")
	}
	if state.Retry != "" && state.Retry != retryNever && state.Retry != retrySameRequest && state.Retry != retryNewTransfer {
		return errors.New("invalid retry guidance")
	}
	if state.PID <= 0 || state.StartedAt.IsZero() || state.UpdatedAt.Before(state.StartedAt) {
		return errors.New("invalid holder or timestamps")
	}
	switch state.Phase {
	case phaseWaiting, phaseConnected, phaseSending, phaseVerified, phaseFailed:
	default:
		return errors.New("invalid transfer phase")
	}
	if state.Acknowledged > state.Size || (state.Phase == phaseVerified && state.Acknowledged != state.Size) {
		return errors.New("invalid verified progress")
	}
	return nil
}

func sameIdentity(a, b transferState) bool {
	return a.TransferID == b.TransferID && a.Code == b.Code && a.Filename == b.Filename && a.Size == b.Size && a.PID == b.PID && a.StartedAt.Equal(b.StartedAt) && a.Log == b.Log
}

// Initial publication is exclusive across processes. Subsequent snapshots
// atomically replace only the same immutable identity; one holder owns updates.
func writeState(dir string, state transferState) error {
	stateWrites.Lock()
	defer stateWrites.Unlock()
	state.UpdatedAt = time.Now().UTC()
	if err := validateState(state); err != nil {
		return NewFailure(failureProtocol, "invalid transfer state: "+err.Error(), retryNever, err)
	}
	return publishState(dir, state, false)
}

func publishState(dir string, state transferState, migrate bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	unlock, err := lockRequest(ctx, filepath.Join(dir, ".state-"+state.TransferID+".lock"))
	if err != nil {
		return NewFailure(failureBusy, "lock transfer state: "+err.Error(), retrySameRequest, err)
	}
	defer unlock()
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err = temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	target := filepath.Join(dir, state.TransferID+".json")
	if err = os.Link(temporary.Name(), target); err == nil {
		return nil
	}
	if !errors.Is(err, os.ErrExist) {
		return err
	}
	previous, err := readStateFile(dir, state.TransferID)
	if err != nil {
		return err
	}
	if !sameIdentity(previous, state) {
		return NewFailure(failureExists, fmt.Sprintf("transfer ID %s already belongs to different inputs or holder", state.TransferID), retryNever)
	}
	if migrate && !state.UpdatedAt.After(previous.UpdatedAt) {
		return nil
	}
	if state.Acknowledged < previous.Acknowledged || (previous.finished() && state.Phase != previous.Phase) {
		return NewFailure(failureProtocol, "transfer snapshot would regress recorded progress or terminal state", retryNever)
	}
	return os.Rename(temporary.Name(), target)
}

func readStateFile(dir, key string) (transferState, error) {
	if !stateKeyPattern.MatchString(key) {
		return transferState{}, errors.New("invalid transfer state filename")
	}
	path := filepath.Join(dir, key+".json")
	info, err := os.Lstat(path)
	if err != nil {
		return transferState{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > 65536 {
		return transferState{}, fmt.Errorf("transfer state for %s is not a regular bounded record", key)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return transferState{}, err
	}
	var state transferState
	if err = json.Unmarshal(data, &state); err == nil {
		err = validateState(state)
	}
	if err == nil && key != state.TransferID && key != state.Code {
		err = errors.New("filename does not match transfer identity")
	}
	if err != nil {
		return transferState{}, NewFailure(failureProtocol, fmt.Sprintf("transfer state for %s is corrupt: %v", key, err), retryNever, err)
	}
	return state, nil
}

func readState(dir, key string) (transferState, error) {
	if !stateKeyPattern.MatchString(key) {
		return transferState{}, errors.New("invalid transfer state lookup")
	}
	states, err := listStates(dir)
	if err != nil {
		return transferState{}, err
	}
	for _, state := range states {
		if state.TransferID == key || (stateCodePattern.MatchString(key) && state.Code == key) {
			return state, nil
		}
	}
	return transferState{}, os.ErrNotExist
}

func newerState(a, b transferState) bool {
	if !a.StartedAt.Equal(b.StartedAt) {
		return a.StartedAt.After(b.StartedAt)
	}
	return a.TransferID > b.TransferID
}

// Preserve legacy code records while old holders may still update them. Copy
// only newer snapshots to the ID path, and deduplicate listing by identity.
func listStates(dir string) ([]transferState, error) {
	stateWrites.Lock()
	defer stateWrites.Unlock()
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	byID := map[string]transferState{}
	for _, entry := range entries {
		key, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || !stateKeyPattern.MatchString(key) {
			continue
		}
		state, err := readStateFile(dir, key)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if previous, ok := byID[state.TransferID]; ok {
			if !sameIdentity(previous, state) {
				return nil, fmt.Errorf("inconsistent history for transfer %s", state.TransferID)
			}
			if !state.UpdatedAt.After(previous.UpdatedAt) {
				continue
			}
		}
		byID[state.TransferID] = state
	}
	states := make([]transferState, 0, len(byID))
	for _, state := range byID {
		canonical, readErr := readStateFile(dir, state.TransferID)
		if readErr == nil && !state.UpdatedAt.After(canonical.UpdatedAt) {
			states = append(states, state)
			continue
		}
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return nil, readErr
		}
		if err := publishState(dir, state, true); err != nil {
			return nil, fmt.Errorf("migrate transfer state: %w", err)
		}
		states = append(states, state)
	}
	sort.Slice(states, func(i, j int) bool { return newerState(states[i], states[j]) })
	return states, nil
}

func effectiveState(dir string, state transferState) transferState {
	if state.finished() || processAlive(state.PID) {
		return state
	}
	if fresh, err := readState(dir, state.TransferID); err == nil && fresh.finished() {
		return fresh
	}
	state.Phase = phaseFailed
	state.Error = "the background sender stopped before the receiver verified the file"
	state.ErrorKind = failureDisconnected
	state.Retry = retryNewTransfer
	return state
}

func pruneStates(dir string, now time.Time) {
	states, err := listStates(dir)
	if err != nil {
		return
	}
	for _, state := range states {
		retention := staleRetention
		if state.finished() {
			retention = finishedRetention
		}
		if now.Sub(state.UpdatedAt) <= retention {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		unlock, err := lockRequest(ctx, filepath.Join(dir, ".state-"+state.TransferID+".lock"))
		if err != nil {
			cancel()
			continue
		}
		canonical, err := readStateFile(dir, state.TransferID)
		if err != nil || canonical.UpdatedAt.After(state.UpdatedAt) {
			unlock()
			cancel()
			continue
		}
		// Never remove a reused code's newer transfer or a path supplied in JSON.
		for _, key := range []string{state.TransferID, state.Code} {
			if key == "" {
				continue
			}
			fresh, err := readStateFile(dir, key)
			if err == nil && fresh.TransferID == state.TransferID && !fresh.UpdatedAt.After(state.UpdatedAt) {
				_ = os.Remove(filepath.Join(dir, key+".json"))
			}
		}
		if filepath.Clean(filepath.Dir(state.Log)) == filepath.Clean(dir) && stateLogPattern.MatchString(filepath.Base(state.Log)) {
			_ = os.Remove(state.Log)
			_ = os.Remove(state.Log + ".failure.json")
		}
		unlock()
		cancel()
	}
}
