package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

var browserURL = regexp.MustCompile(`https://[^[:space:]]+`)

func cdShareURL(crocURL string) (string, error) {
	parsed, err := url.Parse(crocURL)
	if err != nil {
		return "", err
	}
	code := parsed.Query().Get("code")
	if code == "" {
		return "", errors.New("croc did not return a receive code")
	}
	return "https://cd.yash0.in/" + url.PathEscape(code), nil
}

func crocPath() string {
	if configured := os.Getenv("CROC_BIN"); configured != "" {
		return configured
	}
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), "croc")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "croc"
}

func send(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: cdx send <file> [--json]")
	}
	filename := args[0]
	jsonOutput := false
	for _, argument := range args[1:] {
		switch argument {
		case "--json":
			jsonOutput = true
		case "--expire":
			return errors.New("live croc transfers do not use expiry; the link closes after the receiver accepts it")
		default:
			return fmt.Errorf("unknown option %s", argument)
		}
	}
	info, err := os.Stat(filename)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("file must be regular")
	}

	command := exec.Command(crocPath(), "send", "--qr", filename)
	command.Stdout = io.Discard
	logFile, err := os.CreateTemp("", "cdx-croc-*.log")
	if err != nil {
		return err
	}
	command.Stderr = logFile
	configureDetached(command)
	if err := command.Start(); err != nil {
		logFile.Close()
		os.Remove(logFile.Name())
		return fmt.Errorf("croc is not installed; run make croc or set CROC_BIN: %w", err)
	}
	logFile.Close()
	done := waitForExit(command)
	go func() { <-done; os.Remove(logFile.Name()) }()

	for {
		data, _ := os.ReadFile(logFile.Name())
		if url := browserURL.FindString(string(data)); url != "" {
			shareURL, err := cdShareURL(url)
			if err != nil {
				return err
			}
			if jsonOutput {
				return json.NewEncoder(os.Stdout).Encode(map[string]any{"url": shareURL, "filename": filepath.Base(filename), "size": info.Size()})
			}
			_, err = fmt.Fprintln(os.Stdout, shareURL)
			return err
		}
		select {
		case <-done:
			return errors.New("croc stopped before it produced a browser link")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func waitForExit(command *exec.Cmd) <-chan error {
	result := make(chan error, 1)
	go func() { result <- command.Wait() }()
	return result
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: cdx send <file> [--json]")
		os.Exit(2)
	}
	if os.Args[1] != "send" {
		fmt.Fprintf(os.Stderr, "cdx: unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
	if err := send(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		os.Exit(1)
	}
}
