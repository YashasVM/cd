package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Detached sends: `cdx send` (by default when stdout is not a terminal)
// re-executes itself as a background holder in its own session, relays the
// holder's first stdout line (the code or JSON), and exits 0. The holder
// keeps the relay room open until the receiver verifies the file and
// records its progress in a state file that `cdx status` and `cdx wait`
// read. Agents spend one tool call and never hold a long-lived shell.

const (
	phaseWaiting   = "waiting"
	phaseConnected = "connected"
	phaseSending   = "sending"
	phaseVerified  = "verified"
	phaseFailed    = "failed"

	holderCommand = "__hold"
	// readyWait bounds relay admission plus the code claim in the holder.
	readyWait = 30 * time.Second
	// Terminal states are kept a day for `cdx status`; anything older than
	// the relay room lifetime is stale whatever it says.
	finishedRetention = 24 * time.Hour
	staleRetention    = 3 * time.Hour
	waitPollInterval  = 200 * time.Millisecond
)

type transferState struct {
	Version      int       `json:"version"`
	Code         string    `json:"code,omitempty"`
	TransferID   string    `json:"transferId"`
	Filename     string    `json:"filename"`
	Size         uint64    `json:"size"`
	Phase        string    `json:"phase"`
	Acknowledged uint64    `json:"acknowledged"`
	Error        string    `json:"error,omitempty"`
	ErrorKind    string    `json:"errorKind,omitempty"`
	PID          int       `json:"pid"`
	Log          string    `json:"log,omitempty"`
	StartedAt    time.Time `json:"startedAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (state transferState) finished() bool {
	return state.Phase == phaseVerified || state.Phase == phaseFailed
}

// key names the state file: the share code, or the transfer ID in link mode
// (the link's key fragment is never written to disk).
func (state transferState) key() string {
	if state.Code != "" {
		return state.Code
	}
	return state.TransferID
}

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

var stateKeyPattern = regexp.MustCompile(`^(\d{4,5}|[A-Za-z0-9_-]{22})$`)

// stateKeyFromInput accepts a share code, a transfer ID, or a full link.
func stateKeyFromInput(input string) (string, error) {
	input = strings.TrimSpace(input)
	if stateKeyPattern.MatchString(input) {
		return input, nil
	}
	if parsed, err := url.Parse(input); err == nil {
		if id := strings.TrimPrefix(parsed.Path, "/s/"); id != parsed.Path && stateKeyPattern.MatchString(id) {
			return id, nil
		}
	}
	return "", fmt.Errorf("%q is not a share code or link", input)
}

func writeState(dir string, state transferState) error {
	state.UpdatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), filepath.Join(dir, state.key()+".json"))
}

func readState(dir, key string) (transferState, error) {
	data, err := os.ReadFile(filepath.Join(dir, key+".json"))
	if err != nil {
		return transferState{}, err
	}
	var state transferState
	if err := json.Unmarshal(data, &state); err != nil {
		return transferState{}, fmt.Errorf("transfer state for %s is corrupt: %w", key, err)
	}
	return state, nil
}

// effectiveState reports a holder that died without finishing as failed.
// The holder writes its final state before exiting, so a dead process with
// an unfinished state is re-read once to rule out that race.
func effectiveState(dir string, state transferState) transferState {
	if state.finished() || processAlive(state.PID) {
		return state
	}
	if fresh, err := readState(dir, state.key()); err == nil && fresh.finished() {
		return fresh
	}
	state.Phase = phaseFailed
	state.Error = "the background sender stopped before the receiver verified the file"
	state.ErrorKind = failureDisconnected
	return state
}

func listStates(dir string) ([]transferState, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var states []transferState
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		if state, err := readState(dir, strings.TrimSuffix(name, ".json")); err == nil {
			states = append(states, state)
		}
	}
	sort.Slice(states, func(i, j int) bool { return states[i].StartedAt.After(states[j].StartedAt) })
	return states, nil
}

// pruneStates removes old state files and their logs.
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
		if now.Sub(state.UpdatedAt) > retention {
			_ = os.Remove(filepath.Join(dir, state.key()+".json"))
			if state.Log != "" && filepath.Dir(state.Log) == dir {
				_ = os.Remove(state.Log)
			}
		}
	}
}

func holderArgs(request sendRequest, absolutePaths []string) []string {
	args := []string{holderCommand}
	if request.linkMode {
		args = append(args, "--link")
	}
	if request.jsonOutput {
		args = append(args, "--json")
	}
	return append(append(args, "--"), absolutePaths...)
}

// runDetachedSend starts the background holder and returns once it has
// printed the code. Input problems are reported here, before any process
// starts, with the same messages as a foreground send.
func runDetachedSend(request sendRequest) int {
	fail := func(err error) int {
		reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
		return 1
	}
	if _, err := prepareSource(request.files); err != nil {
		return fail(err)
	}
	if _, _, err := endpointBase(); err != nil {
		return fail(err)
	}
	absolutePaths := make([]string, len(request.files))
	for index, path := range request.files {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return fail(err)
		}
		absolutePaths[index] = absolute
	}
	dir, err := stateDir()
	if err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fail(fmt.Errorf("create transfer state directory: %w", err))
	}
	pruneStates(dir, time.Now())
	executable, err := os.Executable()
	if err != nil {
		return fail(fmt.Errorf("find the cdx executable: %w", err))
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	logPath := filepath.Join(dir, "send-"+hex.EncodeToString(suffix)+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fail(fmt.Errorf("create transfer log: %w", err))
	}
	defer logFile.Close()

	holder := exec.Command(executable, holderArgs(request, absolutePaths)...)
	holder.Env = append(os.Environ(), "CD_STATE_DIR="+dir, "CD_HOLDER_LOG="+logPath)
	holder.Stderr = logFile
	holder.SysProcAttr = detachAttributes()
	output, err := holder.StdoutPipe()
	if err != nil {
		return fail(err)
	}
	if err := holder.Start(); err != nil {
		return fail(fmt.Errorf("start the background sender: %w", err))
	}
	line := make(chan string, 1)
	go func() {
		value, _ := bufio.NewReader(output).ReadString('\n')
		line <- value
	}()
	select {
	case value := <-line:
		if strings.HasSuffix(value, "\n") {
			fmt.Fprint(os.Stdout, value)
			fmt.Fprintln(os.Stderr, "sending in the background; `cdx wait <code>` exits 0 once the receiver has the file")
			_ = holder.Process.Release()
			return 0
		}
		// The holder exited before it had a code: its log has the reason.
		_ = holder.Wait()
	case <-time.After(readyWait):
		_ = holder.Process.Kill()
		_ = holder.Wait()
		return fail(errors.New("CD relay did not answer within 30s: check your network and try again"))
	}
	reason := holderFailure(logPath)
	_ = os.Remove(logPath)
	return fail(errors.New(reason))
}

// holderFailure extracts the holder's final `cdx:` error line from its log.
func holderFailure(logPath string) string {
	data, _ := os.ReadFile(logPath)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if strings.HasPrefix(lines[index], "cdx:") {
			return lines[index]
		}
	}
	return "cdx: the background sender failed to start"
}

// runHolder is the background half of a detached send. Its stdout is the
// parent's pipe, used exactly once for the ready line.
func runHolder(args []string) int {
	request, err := parseSendArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
		return 2
	}
	dir := os.Getenv("CD_STATE_DIR")
	if dir == "" {
		fmt.Fprintln(os.Stderr, "cdx: missing transfer state directory")
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	state := transferState{Version: 1, PID: os.Getpid(), Log: os.Getenv("CD_HOLDER_LOG"), StartedAt: time.Now().UTC()}
	lastWrite := time.Time{}
	saved := false
	save := func(force bool) {
		if !saved || (!force && time.Since(lastWrite) < time.Second) {
			return
		}
		if err := writeState(dir, state); err != nil {
			fmt.Fprintln(os.Stderr, "cdx: record transfer state:", err)
		}
		lastWrite = time.Now()
	}
	pipe := os.Stdout
	err = sendFile(ctx, request.files, request.linkMode, sendHooks{
		ready: func(value readyOutput) error {
			state.Code = value.Code
			state.TransferID = transferIDFromURL(value.URL)
			state.Filename = value.Filename
			state.Size = value.Size
			state.Phase = phaseWaiting
			saved = true
			// State first, so `cdx wait` right after the code finds it.
			save(true)
			if err := writeReady(pipe, value, request.jsonOutput); err != nil {
				return err
			}
			_ = pipe.Close()
			return nil
		},
		phase: func(phase string, acknowledged uint64) {
			changed := state.Phase != phase
			state.Phase = phase
			state.Acknowledged = acknowledged
			save(changed)
		},
	})
	if err != nil {
		state.Phase = phaseFailed
		if errors.Is(err, context.Canceled) {
			state.Error = "transfer canceled"
		} else {
			state.Error = strings.TrimSpace(err.Error())
		}
		state.ErrorKind = classifyFailure(err)
		save(true)
		fmt.Fprintln(os.Stderr, "cdx:", state.Error)
		return 1
	}
	state.Phase = phaseVerified
	state.Acknowledged = state.Size
	save(true)
	return 0
}

func transferIDFromURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(parsed.Path, "/s/")
}

func describeState(state transferState) string {
	name := state.key()
	switch state.Phase {
	case phaseSending:
		percent := 100.0
		if state.Size > 0 {
			percent = float64(state.Acknowledged) / float64(state.Size) * 100
		}
		return fmt.Sprintf("%s sending %.0f%% %s", name, percent, state.Filename)
	case phaseFailed:
		return fmt.Sprintf("%s failed %s: %s", name, state.Filename, state.Error)
	default:
		return fmt.Sprintf("%s %s %s", name, state.Phase, state.Filename)
	}
}

func writeStateOutput(output io.Writer, state transferState, jsonOutput bool) {
	if jsonOutput {
		_ = json.NewEncoder(output).Encode(state)
		return
	}
	fmt.Fprintln(output, describeState(state))
}

// runStatus prints one transfer, or every recent one when no code is given.
func runStatus(args []string) int {
	jsonOutput, timeout, rest, err := parseStateArgs(args)
	if err != nil || len(rest) > 1 || timeout != 0 {
		fmt.Fprintln(os.Stderr, "usage: cdx status [--json] [code]")
		return 2
	}
	dir, err := stateDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		return 1
	}
	if len(rest) == 1 {
		state, code := lookupState(dir, rest[0], jsonOutput)
		if code != 0 {
			return code
		}
		writeStateOutput(os.Stdout, effectiveState(dir, state), jsonOutput)
		return 0
	}
	pruneStates(dir, time.Now())
	states, err := listStates(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		return 1
	}
	for _, state := range states {
		writeStateOutput(os.Stdout, effectiveState(dir, state), jsonOutput)
	}
	return 0
}

// runWait blocks until the transfer finishes. Exit 0 means the receiver
// verified the file, 1 means it failed.
func runWait(args []string) int {
	jsonOutput, timeout, rest, err := parseStateArgs(args)
	if err != nil || len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "usage: cdx wait [--json] [--timeout <duration>] <code>")
		return 2
	}
	dir, err := stateDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	state, code := lookupState(dir, rest[0], jsonOutput)
	if code != 0 {
		return code
	}
	var deadline <-chan time.Time
	if timeout > 0 {
		deadline = time.After(timeout)
	}
	for {
		state = effectiveState(dir, state)
		if state.finished() {
			break
		}
		select {
		case <-ctx.Done():
			return 1
		case <-deadline:
			// The send keeps going; only the wait gave up.
			writeStateOutput(os.Stdout, state, jsonOutput)
			fmt.Fprintf(os.Stderr, "cdx: %s not verified within %s (still %s)\n", rest[0], timeout, state.Phase)
			return exitTimeout
		case <-time.After(waitPollInterval):
		}
		if fresh, err := readState(dir, state.key()); err == nil {
			state = fresh
		}
	}
	writeStateOutput(os.Stdout, state, jsonOutput)
	if state.Phase == phaseVerified {
		return 0
	}
	return 1
}

func lookupState(dir, input string, jsonOutput bool) (transferState, int) {
	key, err := stateKeyFromInput(input)
	if err != nil {
		reportFailure(os.Stdout, os.Stderr, err, jsonOutput)
		return transferState{}, 2
	}
	state, err := readState(dir, key)
	if errors.Is(err, os.ErrNotExist) {
		reportFailure(os.Stdout, os.Stderr, fmt.Errorf("no transfer %s was sent from this machine", key), jsonOutput)
		return transferState{}, 1
	}
	if err != nil {
		reportFailure(os.Stdout, os.Stderr, err, jsonOutput)
		return transferState{}, 1
	}
	return state, 0
}

// exitTimeout is `cdx wait --timeout` giving up while the send continues.
const exitTimeout = 3

func parseStateArgs(args []string) (bool, time.Duration, []string, error) {
	jsonOutput := false
	var timeout time.Duration
	var rest []string
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case argument == "--json":
			jsonOutput = true
		case argument == "--timeout" || strings.HasPrefix(argument, "--timeout="):
			value, found := strings.CutPrefix(argument, "--timeout=")
			if !found {
				index++
				if index >= len(args) {
					return false, 0, nil, errors.New("--timeout needs a duration such as 90s or 5m")
				}
				value = args[index]
			}
			parsed, err := time.ParseDuration(value)
			if err != nil || parsed <= 0 {
				return false, 0, nil, fmt.Errorf("--timeout %q is not a duration such as 90s or 5m", value)
			}
			timeout = parsed
		case strings.HasPrefix(argument, "-"):
			return false, 0, nil, fmt.Errorf("unknown option %s", argument)
		default:
			rest = append(rest, argument)
		}
	}
	return jsonOutput, timeout, rest, nil
}
