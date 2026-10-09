package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type updateCheck struct {
	CheckedAt time.Time `json:"checkedAt"`
	Latest    string    `json:"latest"`
}

func notifyUpdate(args []string, output io.Writer) {
	if os.Getenv("CD_NO_UPDATE_CHECK") != "" {
		return
	}
	if len(args) > 0 {
		switch args[0] {
		case "update", "--update", "upgrade", holderCommand:
			return
		}
	}
	current := strings.TrimPrefix(cdVersion(), "cdx ")
	if _, ok := versionNumbers(current); !ok {
		return
	}
	directory, err := os.UserCacheDir()
	if err != nil {
		return
	}
	path := filepath.Join(directory, "cdx", "update-check.json")
	var check updateCheck
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &check)
	}
	now := time.Now()
	if check.CheckedAt.IsZero() || now.Before(check.CheckedAt) || now.Sub(check.CheckedAt) >= time.Hour {
		ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
		latest, err := latestTagContext(ctx)
		cancel()
		if err == nil {
			check.Latest = latest
		}
		check.CheckedAt = now
		saveUpdateCheck(path, check)
	}
	if isNewerRelease(check.Latest, current) {
		fmt.Fprintf(output, "  %s cdx %s available %s\n  Run %s to update.\n\n",
			accent("↑"), bold(check.Latest), dim("(installed "+current+")"), cmdText("cdx update"))
	}
}

func saveUpdateCheck(path string, check updateCheck) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".update-check-*")
	if err != nil {
		return
	}
	defer os.Remove(file.Name())
	err = json.NewEncoder(file).Encode(check)
	closeErr := file.Close()
	if err == nil && closeErr == nil {
		_ = os.Rename(file.Name(), path)
	}
}

func versionNumbers(tag string) ([3]uint64, bool) {
	var numbers [3]uint64
	base, _, _ := strings.Cut(strings.TrimPrefix(tag, "v"), "+")
	base, _, _ = strings.Cut(base, "-")
	parts := strings.Split(base, ".")
	if len(parts) != len(numbers) {
		return numbers, false
	}
	for index, part := range parts {
		if part == "" || len(part) > 1 && part[0] == '0' {
			return numbers, false
		}
		for _, digit := range part {
			if digit < '0' || digit > '9' {
				return numbers, false
			}
		}
		value, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return numbers, false
		}
		numbers[index] = value
	}
	return numbers, true
}

func isNewerRelease(latest, current string) bool {
	// Notices only advertise stable releases, including when the cache is edited.
	if strings.ContainsAny(latest, "-+\x1b\r\n") {
		return false
	}
	next, nextOK := versionNumbers(latest)
	installed, installedOK := versionNumbers(current)
	if !nextOK || !installedOK {
		return false
	}
	for index := range next {
		if next[index] != installed[index] {
			return next[index] > installed[index]
		}
	}
	base, _, _ := strings.Cut(current, "+")
	return strings.Contains(base, "-")
}
