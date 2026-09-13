package main

import (
	"bytes"
	"encoding/json"
	"runtime/debug"
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
