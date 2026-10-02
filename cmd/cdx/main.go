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

// jsonProgress is set by --json: when stderr is not a terminal, progress is
// written there as JSON lines instead of a bar.
var jsonProgress bool

func displayVersion(buildVersion string, info *debug.BuildInfo) string {
	if buildVersion != "" && buildVersion != "dev" {
		return buildVersion
	}
	if info != nil && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

func cdVersion() string {
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
	fmt.Fprintln(output, "   or: cdx send [--link] [--json] [--detach|--wait] [--] <file|folder>...")
	fmt.Fprintln(output, "   or: cdx receive [--out <path>] [--force] [--json] [--] <code>")
	fmt.Fprintln(output, "   or: cdx [--json] [--] <file>  (shorthand for send)")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "Send files through CD at https://cd.yash0.in, or receive them.")
	fmt.Fprintln(output, "Send prints one short share code to stdout. In a terminal it then waits")
	fmt.Fprintln(output, "until the receiver verifies the file; otherwise (agents, scripts, pipes)")
	fmt.Fprintln(output, "it hands the transfer to a background sender and exits 0 right away.")
	fmt.Fprintln(output, "The code works in any browser Receive box and in `cdx receive`. Receive")
	fmt.Fprintln(output, "saves the offered file and prints the saved path to stdout.")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "commands:")
	fmt.Fprintln(output, "  send <path>...     send a file, or several files and folders as one .zip")
	fmt.Fprintln(output, "  receive <code>     receive one file (the 4-5 digit code, or a full link)")
	fmt.Fprintln(output, "  status [code]      show background sends from this machine")
	fmt.Fprintln(output, "  wait <code>        wait for a background send; exit 0 once the receiver verified it")
	fmt.Fprintln(output, "                     (--timeout 5m gives up with exit 3; the send keeps going)")
	fmt.Fprintln(output, "  welcome            replay the getting-started tour")
	fmt.Fprintln(output, "  agent setup        teach your AI coding agents to share files with cdx")
	fmt.Fprintln(output, "  help [send|receive] show help")
	fmt.Fprintln(output, "  update             update cdx to the latest release")
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
	fmt.Fprintln(output, "  --detach       send in the background even from a terminal")
	fmt.Fprintln(output, "  --wait         stay in the foreground until the receiver verifies the file")
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
	fmt.Fprintln(output, "  CD_RELAY_URL   relay WebSocket base (default wss://cd.yash0.in/ws/v1)")
	fmt.Fprintln(output, "  CD_PUBLIC_URL  share-link origin (default https://cd.yash0.in)")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "Exit status 0 means the transfer verified every byte (for a background")
	fmt.Fprintln(output, "send: the code is live; `cdx wait` reports verification). Exit status 1")
	fmt.Fprintln(output, "means the transfer failed; exit status 2 means the command was used incorrectly;")
	fmt.Fprintln(output, "exit status 3 means `cdx wait --timeout` ran out first.")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "With --json, a failure also prints {\"version\",\"error\":{\"kind\",\"message\"}} to")
	fmt.Fprintln(output, "stdout. kind is one of: canceled, invalid_code, not_found, expired, claimed,")
	fmt.Fprintln(output, "exists, busy, stalled, disconnected, network, local_file, protocol, failed.")
	fmt.Fprintln(output, "When stderr is not a terminal, --json also writes progress there as")
	fmt.Fprintln(output, "{\"progress\":{\"phase\",\"done\",\"total\",\"bytesPerSecond\",\"etaSeconds\"}} lines.")
}

func sendUsage(output io.Writer) {
	fmt.Fprintln(output, "usage: cdx send [--link] [--json] [--detach|--wait] [--] <file|folder>...")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "  <path>...      a file, or several files and folders (sent as one .zip)")
	fmt.Fprintln(output, "  --link         print a private end-to-end encrypted link instead of a share code")
	fmt.Fprintln(output, "  --json         print {\"version\",\"url\",\"code\",\"filename\",\"size\"} instead of the bare code")
	fmt.Fprintln(output, "  --detach       send in the background even from a terminal")
	fmt.Fprintln(output, "  --wait         stay in the foreground until the receiver verifies the file")
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
	detach     bool
	wait       bool
	files      []string
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
			return sendRequest{}, errors.New(`cdx: standard input ("-") is not supported: send files or folders`)
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
		if !endOfFlags && argument == "--detach" {
			request.detach = true
			continue
		}
		if !endOfFlags && argument == "--wait" {
			request.wait = true
			continue
		}
		if !endOfFlags && strings.HasPrefix(argument, "-") && argument != "" {
			hint := ""
			switch {
			case strings.HasPrefix(argument, "--js") || argument == "--JSON":
				hint = " (did you mean --json?)"
			case strings.HasPrefix(argument, "--li"):
				hint = " (did you mean --link?)"
			case strings.HasPrefix(argument, "--det"):
				hint = " (did you mean --detach?)"
			case strings.HasPrefix(argument, "--wa"):
				hint = " (did you mean --wait?)"
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
		return sendRequest{}, errors.New("cdx: missing file or folder to send")
	}
	if request.detach && request.wait {
		return sendRequest{}, errors.New("cdx: --detach and --wait cannot be combined")
	}
	request.files = files
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
	candidates := []string{"send", "receive", "status", "wait", "update", "agent", "welcome", "help", "version"}
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

// shouldDetach picks background mode: explicit flags win; otherwise detach
// when stdout is not a terminal (agents, scripts, pipes).
func shouldDetach(request sendRequest, stdoutIsTerminal bool) bool {
	if request.wait {
		return false
	}
	return request.detach || !stdoutIsTerminal
}

func runSend(request sendRequest) int {
	if request.help {
		sendUsage(os.Stdout)
		return 0
	}
	if request.version {
		fmt.Fprintln(os.Stdout, cdVersion())
		return 0
	}
	jsonProgress = request.jsonOutput
	if shouldDetach(request, isTerminal(os.Stdout)) {
		return runDetachedSend(request)
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	card := !request.jsonOutput && isTerminal(os.Stdout)
	err := sendFile(ctx, request.files, request.linkMode, sendHooks{ready: func(value readyOutput) error {
		if card {
			writeReadyCard(os.Stdout, value)
			return nil
		}
		return writeReady(os.Stdout, value, request.jsonOutput)
	}})
	if err != nil {
		reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
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
	jsonProgress = request.jsonOutput
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	err := receiveFile(ctx, request.code, request.out, request.force, func(value receiveResult) error {
		return writeReceived(os.Stdout, value, request.jsonOutput)
	})
	if err != nil {
		reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
		return 1
	}
	return 0
}

func run(argv []string) int {
	if len(argv) == 0 {
		if isTerminal(os.Stdin) && isTerminal(os.Stdout) && !welcomed() {
			return runWelcome(nil)
		}
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
		fmt.Fprintln(os.Stdout, cdVersion())
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
	case "update", "--update", "upgrade":
		return runUpdate(argv[1:])
	case "status":
		return runStatus(argv[1:])
	case "wait":
		return runWait(argv[1:])
	case "agent":
		return runAgent(argv[1:])
	case "welcome":
		return runWelcome(argv[1:])
	case holderCommand:
		return runHolder(argv[1:])
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
			return sendFailure(strings.TrimSpace(err.Error()))
		}
		return runSend(request)
	}
}

func main() {
	os.Exit(run(os.Args[1:]))
}
