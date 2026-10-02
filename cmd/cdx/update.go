package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// releaseBase is where `cdx update` finds releases; a variable so tests can
// point it at a local server. It mirrors scripts/install.sh and install.ps1.
var releaseBase = "https://github.com/YashasVM/cd/releases"

// maxBinaryBytes bounds a downloaded release asset.
const maxBinaryBytes = 128 << 20

var updateClient = &http.Client{Timeout: 2 * time.Minute}

func updateAsset() string {
	name := "cdx-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// latestTag reads the tag GitHub's /releases/latest redirect points at.
func latestTag() (string, error) {
	client := *updateClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Get(releaseBase + "/latest")
	if err != nil {
		return "", fmt.Errorf("check for updates: %w", err)
	}
	response.Body.Close()
	tag := filepath.Base(response.Header.Get("Location"))
	if !strings.HasPrefix(tag, "v") {
		return "", errors.New("check for updates: could not find the latest release")
	}
	return tag, nil
}

func download(url string, limit int64) ([]byte, error) {
	response, err := updateClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: %s", url, response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("download %s: too large", url)
	}
	return data, nil
}

// checksumFor finds asset's sha256 in a `sha256sum`-style checksums.txt.
func checksumFor(checksums []byte, asset string) (string, bool) {
	scanner := bufio.NewScanner(bytes.NewReader(checksums))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == asset {
			return strings.ToLower(fields[0]), true
		}
	}
	return "", false
}

// replaceExecutable swaps target for data. Windows can't overwrite a running
// .exe but can rename it, so the old binary moves aside to <target>.old and
// is removed on the next update.
func replaceExecutable(target string, data []byte) error {
	_ = os.Remove(target + ".old")
	next, err := os.CreateTemp(filepath.Dir(target), ".cdx-update-*")
	if err != nil {
		return err
	}
	defer os.Remove(next.Name())
	if _, err := next.Write(data); err != nil {
		next.Close()
		return err
	}
	if err := next.Close(); err != nil {
		return err
	}
	if err := os.Chmod(next.Name(), 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		if err := os.Rename(target, target+".old"); err != nil {
			return err
		}
		if err := os.Rename(next.Name(), target); err != nil {
			_ = os.Rename(target+".old", target)
			return err
		}
		return nil
	}
	return os.Rename(next.Name(), target)
}

func runUpdate(args []string) int {
	if len(args) > 0 {
		fmt.Fprintln(os.Stderr, "usage: cdx update")
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, "cdx: update failed:", underlyingReason(err))
		return 1
	}
	tag, err := latestTag()
	if err != nil {
		return fail(err)
	}
	if version == tag {
		fmt.Fprintf(os.Stderr, "cdx %s is already the latest version\n", tag)
		return 0
	}
	asset := updateAsset()
	base := releaseBase + "/download/" + tag + "/"
	fmt.Fprintf(os.Stderr, "updating cdx %s -> %s\n", version, tag)
	checksums, err := download(base+"checksums.txt", 1<<20)
	if err != nil {
		return fail(err)
	}
	want, ok := checksumFor(checksums, asset)
	if !ok {
		return fail(fmt.Errorf("release %s has no %s", tag, asset))
	}
	data, err := download(base+asset, maxBinaryBytes)
	if err != nil {
		return fail(err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != want {
		return fail(errors.New("checksum mismatch; nothing was changed"))
	}
	target, err := os.Executable()
	if err == nil {
		target, err = filepath.EvalSymlinks(target)
	}
	if err != nil {
		return fail(fmt.Errorf("find the cdx executable: %w", err))
	}
	if err := replaceExecutable(target, data); err != nil {
		return fail(fmt.Errorf("replace %s: %w (try re-running the installer)", target, err))
	}
	fmt.Fprintf(os.Stderr, "updated %s to %s\n", target, tag)
	return 0
}
