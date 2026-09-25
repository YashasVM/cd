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
	Code     string `json:"code,omitempty"`
	Filename string `json:"filename"`
	Size     uint64 `json:"size"`
}

func writeReady(output io.Writer, value readyOutput, jsonOutput bool) error {
	if jsonOutput {
		return json.NewEncoder(output).Encode(value)
	}
	line := value.URL
	if value.Code != "" {
		line = value.Code
	}
	_, err := fmt.Fprintln(output, line)
	return err
}

func writeReceived(output io.Writer, value receiveResult, jsonOutput bool) error {
	if jsonOutput {
		return json.NewEncoder(output).Encode(value)
	}
	_, err := fmt.Fprintln(output, value.Path)
	return err
}

func usage(output io.Writer) {
	fmt.Fprintln(output, "usage: cdx <command> [options] [file]")
	fmt.Fprintln(output, "   or: cdx send [--link] [--json] [--] <file>")
	fmt.Fprintln(output, "   or: cdx receive [--out <path>] [--force] [--json] [--] <code>")
	fmt.Fprintln(output, "   or: cdx [--json] [--] <file>  (shorthand for send)")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "Send one file through CD at https://cdx.yash0.in, or receive one.")
	fmt.Fprintln(output, "Send prints one short share code to stdout, then waits")
	fmt.Fprintln(output, "until the receiver verifies the file. The code works in")
	fmt.Fprintln(output, "any browser Receive box and in `cdx receive`. Receive")
	fmt.Fprintln(output, "saves the offered file and prints the saved path to stdout.")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "commands:")
	fmt.Fprintln(output, "  send <file>        send one regular file (zip a folder first to share it)")
	fmt.Fprintln(output, "  receive <code>     receive one file (the 4-5 digit code, or a full link)")
	fmt.Fprintln(output, "  help [send|receive] show help")
	fmt.Fprintln(output, "  version            show version")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "options for receive:")
	fmt.Fprintln(output, "  --out <path>   save to this file or directory (default: sender's filename)")
	fmt.Fprintln(output, "  --force        overwrite an existing file")
	fmt.Fprintln(output, "  --json         print {\"version\",\"filename\",\"size\",\"path\"} instead of the bare path")
	fmt.Fprintln(output, "  --             treat the next argument as the code even if it starts with -")
	fmt.Fprintln(output, "  -h, --help     show help for receive")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "options for send:")
	fmt.Fprintln(output, "  --link         print a private end-to-end encrypted link instead of a share code")
	fmt.Fprintln(output, "  --json         print {\"version\",\"url\",\"code\",\"filename\",\"size\"} instead of the bare code")
	fmt.Fprintln(output, "  --             treat the next argument as the file even if it starts with -")
	fmt.Fprintln(output, "  -h, --help     show help for send")
	fmt.Fprintln(output, "  -v, --version  show version")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "examples:")
	fmt.Fprintln(output, "  cdx send ./app.apk")
	fmt.Fprintln(output, "  cdx receive 48291 --out ./downloads/")
	fmt.Fprintln(output, "  cdx \"./my photo.zip\" --json")
	fmt.Fprintln(output, "  cdx send -- -weird-name.bin")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "environment:")
	fmt.Fprintln(output, "  CD_RELAY_URL   relay WebSocket base (default wss://cdx.yash0.in/ws/v1)")
	fmt.Fprintln(output, "  CD_PUBLIC_URL  share-link origin (default https://cdx.yash0.in)")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "exit status 0 means the transfer verified every byte.")
	fmt.Fprintln(output, "Exit status 1 means the transfer failed; exit status 2 means")
	fmt.Fprintln(output, "the command was used incorrectly.")
}

func sendUsage(output io.Writer) {
	fmt.Fprintln(output, "usage: cdx send [--link] [--json] [--] <file>")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "  <file>         one regular file to share (zip a folder first)")
	fmt.Fprintln(output, "  --link         print a private end-to-end encrypted link instead of a share code")
	fmt.Fprintln(output, "  --json         print {\"version\",\"url\",\"code\",\"filename\",\"size\"} instead of the bare code")
	fmt.Fprintln(output, "  --             treat the next argument as the file even if it starts with -")
	fmt.Fprintln(output, "  -h, --help     show this help")
	fmt.Fprintln(output, "  -v, --version  show version")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "examples:")
	fmt.Fprintln(output, "  cdx send ./app.apk")
	fmt.Fprintln(output, "  cdx send \"./my photo.zip\" --json")
	fmt.Fprintln(output, "  cdx send -- -weird-name.bin")
}

func receiveUsage(output io.Writer) {
	fmt.Fprintln(output, "usage: cdx receive [--out <path>] [--force] [--json] [--] <code>")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "  <code>           the 4-5 digit code from `cdx send` or a browser sender")
	fmt.Fprintln(output, "                   (a full share link works too)")
	fmt.Fprintln(output, "  --out <path>   save to this file or directory (default: sender's filename)")
	fmt.Fprintln(output, "  --force        overwrite an existing file")
	fmt.Fprintln(output, "  --json         print {\"version\",\"filename\",\"size\",\"path\"} instead of the bare path")
	fmt.Fprintln(output, "  --             treat the next argument as the code even if it starts with -")
	fmt.Fprintln(output, "  -h, --help     show this help")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "examples:")
	fmt.Fprintln(output, "  cdx receive 48291")
	fmt.Fprintln(output, "  cdx receive 48291 --out ./downloads/ --force")
}

// sendRequest is the parsed form of send arguments.
type sendRequest struct {
	jsonOutput bool
	linkMode   bool
	file       string
	help       bool
	version    bool
}

// receiveRequest is the parsed form of receive arguments.
type receiveRequest struct {
	jsonOutput bool
	force      bool
	out        string
	code       string
	help       bool
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
		if !endOfFlags && argument == "--link" {
			request.linkMode = true
			continue
		}
		if !endOfFlags && strings.HasPrefix(argument, "-") && argument != "" {
			hint := ""
			switch {
			case strings.HasPrefix(argument, "--js") || argument == "--JSON":
				hint = " (did you mean --json?)"
			case strings.HasPrefix(argument, "--li"):
				hint = " (did you mean --link?)"
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

func parseReceiveArgs(args []string) (receiveRequest, error) {
	var request receiveRequest
	var codes []string
	endOfFlags := false
	index := 0
	for index < len(args) {
		argument := args[index]
		if !endOfFlags && argument == "--" {
			endOfFlags = true
			index++
			continue
		}
		if !endOfFlags && (argument == "--help" || argument == "-h") {
			return receiveRequest{help: true}, nil
		}
		if !endOfFlags && argument == "--json" {
			request.jsonOutput = true
			index++
			continue
		}
		if !endOfFlags && argument == "--force" {
			request.force = true
			index++
			continue
		}
		if !endOfFlags && (argument == "--out" || strings.HasPrefix(argument, "--out=")) {
			value := ""
			if strings.HasPrefix(argument, "--out=") {
				value = strings.TrimPrefix(argument, "--out=")
			} else {
				index++
				if index >= len(args) {
					return receiveRequest{}, errors.New("cdx: --out needs a path")
				}
				value = args[index]
			}
			if value == "" {
				return receiveRequest{}, errors.New("cdx: --out needs a path")
			}
			request.out = value
			index++
			continue
		}
		if !endOfFlags && strings.HasPrefix(argument, "-") && argument != "" {
			hint := ""
			switch {
			case strings.HasPrefix(argument, "--ou"):
				hint = " (did you mean --out?)"
			case strings.HasPrefix(argument, "--for"):
				hint = " (did you mean --force?)"
			case strings.HasPrefix(argument, "--js") || argument == "--JSON":
				hint = " (did you mean --json?)"
			case strings.HasPrefix(argument, "--he"):
				hint = " (did you mean --help?)"
			}
			return receiveRequest{}, fmt.Errorf("cdx: unknown option %s%s", argument, hint)
		}
		if argument == "" {
			index++
			continue
		}
		codes = append(codes, argument)
		index++
	}
	if len(codes) == 0 {
		return receiveRequest{}, errors.New("cdx: missing share code or link (paste the link from `cdx send`)")
	}
	if len(codes) > 1 {
		return receiveRequest{}, errors.New("cdx: receive one transfer at a time")
	}
	request.code = codes[0]
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
	candidates := []string{"send", "receive", "help", "version"}
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
	err := sendFile(ctx, request.file, request.linkMode, func(value readyOutput) error {
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

// receiveFailure prints a usage error for the receive command.
func receiveFailure(message string) int {
	fmt.Fprintln(os.Stderr, message)
	fmt.Fprintln(os.Stderr, "")
	receiveUsage(os.Stderr)
	return 2
}

func runReceive(request receiveRequest) int {
	if request.help {
		receiveUsage(os.Stdout)
		return 0
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	err := receiveFile(ctx, request.code, request.out, request.force, func(value receiveResult) error {
		return writeReceived(os.Stdout, value, request.jsonOutput)
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
			if argv[1] == "receive" {
				receiveUsage(os.Stdout)
				return 0
			}
			if suggestion, ok := looksLikeCommandTypo(argv[1]); ok {
				fmt.Fprintf(os.Stderr, "cdx: unknown help topic %q (did you mean '%s'?)\n", argv[1], suggestion)
				return 2
			}
			fmt.Fprintf(os.Stderr, "cdx: unknown help topic %q (try 'cdx help send' or 'cdx help receive')\n", argv[1])
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
	case "receive":
		request, err := parseReceiveArgs(argv[1:])
		if err != nil {
			return receiveFailure(strings.TrimSpace(err.Error()))
		}
		return runReceive(request)
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
