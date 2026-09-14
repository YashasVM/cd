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

func cdxVersion() string {
	info, _ := debug.ReadBuildInfo()
	return "cdx " + displayVersion(version, info)
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

func usage(output io.Writer) {
	fmt.Fprintln(output, "usage: cdx <command> [options] [file]")
	fmt.Fprintln(output, "   or: cdx send [--json] [--] <file>")
	fmt.Fprintln(output, "   or: cdx [--json] [--] <file>  (shorthand for send)")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "Send one file through CD at https://cd.yash0.in.")
	fmt.Fprintln(output, "Prints one private share URL to stdout, then waits")
	fmt.Fprintln(output, "until the receiver verifies the file.")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "commands:")
	fmt.Fprintln(output, "  send <file>   send one regular file (zip a folder first to share it)")
	fmt.Fprintln(output, "  help [send]   show help")
	fmt.Fprintln(output, "  version       show version")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "options for send:")
	fmt.Fprintln(output, "  --json        print {\"version\",\"url\",\"filename\",\"size\"} instead of the bare URL")
	fmt.Fprintln(output, "  --            treat the next argument as the file even if it starts with -")
	fmt.Fprintln(output, "  -h, --help    show help for send")
	fmt.Fprintln(output, "  -v, --version show version")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "examples:")
	fmt.Fprintln(output, "  cdx send ./app.apk")
	fmt.Fprintln(output, "  cdx \"./my photo.zip\" --json")
	fmt.Fprintln(output, "  cdx send -- -weird-name.bin")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "environment:")
	fmt.Fprintln(output, "  CD_RELAY_URL   relay WebSocket base (default wss://cd.yash0.in/ws/v1)")
	fmt.Fprintln(output, "  CD_PUBLIC_URL  share-link origin (default https://cd.yash0.in)")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "exit status 0 means the receiver verified every byte.")
	fmt.Fprintln(output, "Exit status 1 means the transfer failed; exit status 2 means")
	fmt.Fprintln(output, "the command was used incorrectly.")
}

func sendUsage(output io.Writer) {
	fmt.Fprintln(output, "usage: cdx send [--json] [--] <file>")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "  <file>         one regular file to share (zip a folder first)")
	fmt.Fprintln(output, "  --json         print {\"version\",\"url\",\"filename\",\"size\"} instead of the bare URL")
	fmt.Fprintln(output, "  --             treat the next argument as the file even if it starts with -")
	fmt.Fprintln(output, "  -h, --help     show this help")
	fmt.Fprintln(output, "  -v, --version  show version")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "examples:")
	fmt.Fprintln(output, "  cdx send ./app.apk")
	fmt.Fprintln(output, "  cdx send \"./my photo.zip\" --json")
	fmt.Fprintln(output, "  cdx send -- -weird-name.bin")
}

// sendRequest is the parsed form of send arguments.
type sendRequest struct {
	jsonOutput bool
	file       string
	help       bool
	version    bool
}

func parseSendArgs(args []string) (sendRequest, error) {
	var request sendRequest
	var files []string
	endOfFlags := false
	for _, argument := range args {
		if !endOfFlags && argument == "--" {
			endOfFlags = true
			continue
		}
		if argument == "-" {
			return sendRequest{}, errors.New(`cdx: standard input ("-") is not supported: send one regular file`)
		}
		if !endOfFlags && (argument == "--help" || argument == "-h") {
			return sendRequest{help: true}, nil
		}
		if !endOfFlags && (argument == "--version" || argument == "-v") {
			return sendRequest{version: true}, nil
		}
		if !endOfFlags && argument == "--json" {
			request.jsonOutput = true
			continue
		}
		if !endOfFlags && strings.HasPrefix(argument, "-") && argument != "" {
			hint := ""
			switch {
			case strings.HasPrefix(argument, "--js") || argument == "--JSON":
				hint = " (did you mean --json?)"
			case strings.HasPrefix(argument, "--he"):
				hint = " (did you mean --help?)"
			case strings.HasPrefix(argument, "--ver"):
				hint = " (did you mean --version?)"
			}
			return sendRequest{}, fmt.Errorf("cdx: unknown option %s%s", argument, hint)
		}
		if argument == "" {
			continue
		}
		files = append(files, argument)
	}
	if len(files) == 0 {
		return sendRequest{}, errors.New("cdx: missing file to send")
	}
	if len(files) > 1 {
		return sendRequest{}, errors.New("cdx: send one file at a time (zip a folder first to share it)")
	}
	request.file = files[0]
	return request, nil
}

// editDistance reports the Levenshtein distance between two short strings.
func editDistance(a, b string) int {
	previous := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		current := make([]int, len(b)+1)
		current[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 0
			if a[i-1] != b[j-1] {
				cost = 1
			}
			deletion := previous[j] + 1
			insertion := current[j-1] + 1
			substitution := previous[j-1] + cost
			current[j] = deletion
			if insertion < current[j] {
				current[j] = insertion
			}
			if substitution < current[j] {
				current[j] = substitution
			}
		}
		previous = current
	}
	return previous[len(b)]
}

func suggestCommand(argument string) string {
	candidates := []string{"send", "help", "version"}
	best := ""
	bestDistance := 3
	for _, candidate := range candidates {
		if distance := editDistance(strings.ToLower(argument), candidate); distance < bestDistance {
			bestDistance = distance
			best = candidate
		}
	}
	return best
}

// looksLikeCommandTypo reports whether argument is probably a mistyped command
// rather than a file path: no slashes, no dots, no such file, close to a command.
func looksLikeCommandTypo(argument string) (string, bool) {
	if argument == "" || strings.Contains(argument, "/") || strings.Contains(argument, ".") {
		return "", false
	}
	if _, err := os.Stat(argument); err == nil {
		return "", false
	}
	if suggestion := suggestCommand(argument); suggestion != "" {
		return suggestion, true
	}
	return "", false
}

func runSend(request sendRequest) int {
	if request.help {
		sendUsage(os.Stdout)
		return 0
	}
	if request.version {
		fmt.Fprintln(os.Stdout, cdxVersion())
		return 0
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	err := sendFile(ctx, request.file, func(value readyOutput) error {
		return writeReady(os.Stdout, value, request.jsonOutput)
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			fmt.Fprintln(os.Stderr, "cdx: transfer canceled")
		} else {
			fmt.Fprintln(os.Stderr, "cdx:", strings.TrimSpace(err.Error()))
		}
		return 1
	}
	return 0
}

// sendFailure prints a usage error for the send command.
func sendFailure(message string) int {
	fmt.Fprintln(os.Stderr, message)
	fmt.Fprintln(os.Stderr, "")
	sendUsage(os.Stderr)
	return 2
}

func run(argv []string) int {
	if len(argv) == 0 {
		usage(os.Stderr)
		return 2
	}
	switch argv[0] {
	case "--help", "-h", "help":
		if len(argv) > 1 {
			if argv[1] == "send" {
				sendUsage(os.Stdout)
				return 0
			}
			if suggestion, ok := looksLikeCommandTypo(argv[1]); ok {
				fmt.Fprintf(os.Stderr, "cdx: unknown help topic %q (did you mean '%s'?)\n", argv[1], suggestion)
				return 2
			}
			fmt.Fprintf(os.Stderr, "cdx: unknown help topic %q (try 'cdx help send')\n", argv[1])
			return 2
		}
		usage(os.Stdout)
		return 0
	case "--version", "-v", "version":
		fmt.Fprintln(os.Stdout, cdxVersion())
		return 0
	case "send":
		request, err := parseSendArgs(argv[1:])
		if err != nil {
			return sendFailure(strings.TrimSpace(err.Error()))
		}
		return runSend(request)
	default:
		if strings.HasPrefix(argv[0], "-") {
			request, err := parseSendArgs(argv)
			if err != nil {
				return sendFailure(err.Error())
			}
			return runSend(request)
		}
		if suggestion, ok := looksLikeCommandTypo(argv[0]); ok && len(argv) == 1 {
			fmt.Fprintf(os.Stderr, "cdx: unknown command %q (did you mean '%s'?)\n\n", argv[0], suggestion)
			usage(os.Stderr)
			return 2
		}
		// Implicit send: `cdx <file>` behaves like `cdx send <file>`.
		request, err := parseSendArgs(argv)
		if err != nil {
			message := strings.TrimSpace(err.Error())
			if strings.Contains(message, "one file at a time") {
				fmt.Fprintln(os.Stderr, message)
				fmt.Fprintln(os.Stderr, "hint: cdx send [--json] [--] <file>")
				return 2
			}
			return sendFailure(message)
		}
		return runSend(request)
	}
}

func main() {
	os.Exit(run(os.Args[1:]))
}
