package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
)

var version = "dev"

func displayVersion(buildVersion string, info *debug.BuildInfo) string {
	if buildVersion != "" && buildVersion != "dev" {
		return buildVersion
	}
	if info != nil && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

type readyOutput struct {
	Version  int    `json:"version"`
	URL      string `json:"url"`
	Filename string `json:"filename"`
	Size     uint64 `json:"size"`
}

func writeReady(output io.Writer, value readyOutput, jsonOutput bool) error {
	if jsonOutput {
		return json.NewEncoder(output).Encode(value)
	}
	_, err := fmt.Fprintln(output, value.URL)
	return err
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: cdx send [--json] <file>")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Send one file through CD at https://cd.yash0.in.")
	fmt.Fprintln(os.Stderr, "Prints one private share URL to stdout, then waits")
	fmt.Fprintln(os.Stderr, "until the receiver verifies the file.")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "examples:")
	fmt.Fprintln(os.Stderr, "  cdx send ./app.apk")
	fmt.Fprintln(os.Stderr, "  cdx send \"./my photo.zip\" --json")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "exit status 0 means the receiver verified every byte.")
}

func sendUsage() {
	fmt.Fprintln(os.Stderr, "usage: cdx send [--json] <file>")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "  <file>    one regular file to share")
	fmt.Fprintln(os.Stderr, "  --json    print {\"version\",\"url\",\"filename\",\"size\"} instead of the bare URL")
}

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "version" || os.Args[1] == "-v") {
		info, _ := debug.ReadBuildInfo()
		fmt.Fprintln(os.Stdout, "cdx "+displayVersion(version, info))
		return
	}
	if len(os.Args) == 2 && (os.Args[1] == "--help" || os.Args[1] == "help" || os.Args[1] == "-h") {
		usage()
		return
	}
	if len(os.Args) < 3 || os.Args[1] != "send" {
		usage()
		os.Exit(2)
	}
	if len(os.Args) == 3 && (os.Args[2] == "--help" || os.Args[2] == "help" || os.Args[2] == "-h") {
		sendUsage()
		return
	}
	jsonOutput := false
	var files []string
	for _, argument := range os.Args[2:] {
		switch argument {
		case "--json":
			jsonOutput = true
		case "--help", "-h", "help":
			sendUsage()
			return
		case "--version", "-v", "version":
			info, _ := debug.ReadBuildInfo()
			fmt.Fprintln(os.Stdout, "cdx "+displayVersion(version, info))
			return
		default:
			if strings.HasPrefix(argument, "-") {
				fmt.Fprintf(os.Stderr, "cdx: unknown option %s\n\n", argument)
				sendUsage()
				os.Exit(2)
			}
			files = append(files, argument)
		}
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "cdx: missing file to send")
		fmt.Fprintln(os.Stderr, "")
		sendUsage()
		os.Exit(2)
	}
	if len(files) > 1 {
		fmt.Fprintln(os.Stderr, "cdx: send one file at a time (zip a folder first to share it)")
		fmt.Fprintln(os.Stderr, "")
		sendUsage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	err := sendFile(ctx, files[0], func(value readyOutput) error { return writeReady(os.Stdout, value, jsonOutput) })
	if err != nil {
		if errors.Is(err, context.Canceled) {
			fmt.Fprintln(os.Stderr, "cdx: transfer canceled")
		} else {
			fmt.Fprintln(os.Stderr, "cdx:", strings.TrimSpace(err.Error()))
		}
		os.Exit(1)
	}
}
