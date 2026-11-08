package main

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

func TestRecoveryShellQuoting(t *testing.T) {
	got := shellCommand([]string{"cdx", "send", "--", "a'b", "$(touch /tmp/no)"})
	want := `'cdx' 'send' '--' 'a'"'"'b' '$(touch /tmp/no)'`
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestWindowsRecoveryShellQuoting(t *testing.T) {
	got := shellCommandForOS([]string{"cdx", "send", "--", "a'b", "$x; & whoami"}, "windows")
	if want := "& 'cdx' 'send' '--' 'a''b' '$x; & whoami'"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestDeviceDestinationRejectedBeforeDetach(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CD_DEVICE_DIR", dir)
	for _, target := range []string{"missing-alias", "picker"} {
		t.Run(target, func(t *testing.T) {
			original := os.Stdout
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			os.Stdout = writer
			defer func() { os.Stdout = original }()
			status := runDeviceSend(sendRequest{to: target, jsonOutput: true, detach: true, files: []string{"missing-source"}})
			writer.Close()
			output, err := io.ReadAll(reader)
			reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			want := "cannot load saved destination"
			if target == "picker" {
				want = "requires an interactive terminal"
			}
			if !strings.Contains(string(output), want) {
				t.Fatalf("missing destination error: %s", output)
			}
			if status == 0 {
				t.Fatal("invalid destination started a background sender")
			}
		})
	}
}

func TestHelpKeepsDetailedOptions(t *testing.T) {
	var root bytes.Buffer
	usage(&root)
	if strings.Contains(root.String(), "options for") {
		t.Fatal("root help contains detailed options")
	}
	for _, help := range []func(io.Writer){sendUsage, receiveUsage} {
		var out bytes.Buffer
		help(&out)
		for _, option := range []string{"--request-id", "--detach", "--resume", "CD_PUBLIC_URL", "Exit status", "--force"} {
			if !strings.Contains(out.String(), option) {
				t.Fatalf("help lost %s", option)
			}
		}
	}
}
