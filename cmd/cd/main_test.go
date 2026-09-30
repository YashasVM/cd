package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"runtime/debug"
	"strings"
	"testing"
)

func TestDisplayVersionUsesReleaseOrModuleVersion(t *testing.T) {
	info := &debug.BuildInfo{Main: debug.Module{Version: "v1.2.3"}}
	if got := displayVersion("v2.0.0", info); got != "v2.0.0" {
		t.Fatalf("release version = %q", got)
	}
	if got := displayVersion("dev", info); got != "v1.2.3" {
		t.Fatalf("module version = %q", got)
	}
	if got := displayVersion("dev", &debug.BuildInfo{Main: debug.Module{Version: "(devel)"}}); got != "dev" {
		t.Fatalf("development version = %q", got)
	}
}

func TestWriteReadyKeepsStdoutMachineReadable(t *testing.T) {
	ready := readyOutput{Version: 1, URL: "https://cd.yash0.in/s/id#v1.key", Filename: "file.txt", Size: 42}

	var plain bytes.Buffer
	if err := writeReady(&plain, ready, false); err != nil {
		t.Fatal(err)
	}
	if plain.String() != ready.URL+"\n" {
		t.Fatalf("plain output = %q", plain.String())
	}

	var structured bytes.Buffer
	if err := writeReady(&structured, ready, true); err != nil {
		t.Fatal(err)
	}
	var decoded readyOutput
	if err := json.Unmarshal(structured.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded != ready {
		t.Fatalf("JSON output = %#v", decoded)
	}
}

func TestWriteReadyPrefersShareCode(t *testing.T) {
	ready := readyOutput{Version: 1, URL: "https://cd.yash0.in/s/id#v1.key", Code: "48291", Filename: "file.txt", Size: 42}

	var plain bytes.Buffer
	if err := writeReady(&plain, ready, false); err != nil {
		t.Fatal(err)
	}
	if plain.String() != "48291\n" {
		t.Fatalf("plain output = %q", plain.String())
	}

	var structured bytes.Buffer
	if err := writeReady(&structured, ready, true); err != nil {
		t.Fatal(err)
	}
	var decoded readyOutput
	if err := json.Unmarshal(structured.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded != ready {
		t.Fatalf("JSON output = %#v", decoded)
	}
}

func TestParseSendArgsAcceptsFlagBeforeOrAfterFile(t *testing.T) {
	before, err := parseSendArgs([]string{"--json", "file.bin"})
	if err != nil || !before.jsonOutput || before.file != "file.bin" {
		t.Fatalf("flag before file = %#v, %v", before, err)
	}
	after, err := parseSendArgs([]string{"file.bin", "--json"})
	if err != nil || !after.jsonOutput || after.file != "file.bin" {
		t.Fatalf("flag after file = %#v, %v", after, err)
	}
	link, err := parseSendArgs([]string{"--link", "file.bin"})
	if err != nil || !link.linkMode || link.file != "file.bin" {
		t.Fatalf("link flag = %#v, %v", link, err)
	}
}

func TestParseSendArgsSupportsDoubleDashForLeadingDashNames(t *testing.T) {
	request, err := parseSendArgs([]string{"--", "-weird.bin"})
	if err != nil || request.file != "-weird.bin" {
		t.Fatalf("double dash = %#v, %v", request, err)
	}
	request, err = parseSendArgs([]string{"--", "--json"})
	if err != nil || request.file != "--json" {
		t.Fatalf("double dash flag-like file = %#v, %v", request, err)
	}
	if _, err := parseSendArgs([]string{"-weird.bin"}); err == nil {
		t.Fatal("leading-dash file without -- was accepted")
	}
}

func TestParseSendArgsTreatsBareHelpAndVersionAsFiles(t *testing.T) {
	for _, name := range []string{"help", "version"} {
		request, err := parseSendArgs([]string{name})
		if err != nil || request.file != name || request.help || request.version {
			t.Fatalf("%q = %#v, %v (must be a sendable file, not help/version)", name, request, err)
		}
	}
}

func TestParseSendArgsRejectsStdinAndBadOptions(t *testing.T) {
	if _, err := parseSendArgs([]string{"-"}); err == nil {
		t.Fatal("stdin was accepted")
	}
	if _, err := parseSendArgs([]string{"--json=1", "file.bin"}); err == nil {
		t.Fatal("--json=1 was accepted")
	}
	if _, err := parseSendArgs([]string{}); err == nil {
		t.Fatal("missing file was accepted")
	}
	if _, err := parseSendArgs([]string{"a", "b"}); err == nil {
		t.Fatal("two files were accepted")
	}
}

func TestParseSendArgsHelpAndVersionWin(t *testing.T) {
	help, err := parseSendArgs([]string{"--help", "file.bin"})
	if err != nil || !help.help {
		t.Fatalf("help = %#v, %v", help, err)
	}
	version, err := parseSendArgs([]string{"-v", "file.bin"})
	if err != nil || !version.version {
		t.Fatalf("version = %#v, %v", version, err)
	}
}

func TestSuggestCommandCatchesSendTypos(t *testing.T) {
	for _, typo := range []string{"snd", "sned", "sends"} {
		if got := suggestCommand(typo); got != "send" {
			t.Fatalf("suggestion for %q = %q", typo, got)
		}
	}
	if got := suggestCommand("t3code-explainer.mp4"); got == "send" {
		t.Fatalf("filename suggested as command: %q", got)
	}
}

func TestRunReportsTheInvalidOptionAfterJSON(t *testing.T) {
	original := os.Stderr
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	os.Stderr = writer
	defer func() { os.Stderr = original }()
	status := run([]string{"--json", "--invalid", "file.bin"})
	writer.Close()
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if status != 2 || !strings.Contains(string(output), "unknown option --invalid") {
		t.Fatalf("status = %d, stderr = %q", status, output)
	}
}
