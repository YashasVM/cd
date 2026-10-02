package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

// The welcome tour runs on a bare `cdx` the first time and after install. It
// introduces cdx, offers agent setup, and shows how to send a file.

var wordmark = []string{
	" ██████╗██████╗ ██╗  ██╗",
	"██╔════╝██╔══██╗╚██╗██╔╝",
	"██║     ██║  ██║ ╚███╔╝ ",
	"██║     ██║  ██║ ██╔██╗ ",
	"╚██████╗██████╔╝██╔╝ ██╗",
	" ╚═════╝╚═════╝ ╚═╝  ╚═╝",
}

// wordmarkColors runs violet to pink down the wordmark.
var wordmarkColors = []string{"38;5;99", "38;5;105", "38;5;141", "38;5;177", "38;5;213", "38;5;219"}

var welcomeFeatures = [][2]string{
	{"Peer to peer", "direct between devices whenever the network allows"},
	{"Encrypted", "every byte verified · --link for end-to-end privacy"},
	{"No accounts", "nothing to sign up for, nothing kept on a server"},
	{"Anywhere", "phone, browser, or another terminal"},
}

type welcome struct {
	out   io.Writer
	tty   *os.File
	speed time.Duration
}

func welcomeMarker() string {
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, _ := os.UserHomeDir()
		configHome = filepath.Join(home, ".config")
	}
	return filepath.Join(configHome, "cdx", "welcomed")
}

func welcomed() bool {
	_, err := os.Stat(welcomeMarker())
	return err == nil
}

func runWelcome(argv []string) int {
	w := welcome{out: os.Stdout, speed: time.Millisecond}
	for _, argument := range argv {
		switch argument {
		case "--fast":
			w.speed = 0
		case "-h", "--help":
			fmt.Fprintln(os.Stdout, "usage: cdx welcome [--fast]")
			fmt.Fprintln(os.Stdout, "")
			fmt.Fprintln(os.Stdout, "Replay the getting-started tour: what cdx is, AI agent setup, and")
			fmt.Fprintln(os.Stdout, "how to send your first file. --fast skips the animations.")
			return 0
		default:
			fmt.Fprintf(os.Stderr, "cdx: unknown option %s for welcome\n", argument)
			return 2
		}
	}
	if !isTerminal(os.Stdout) {
		w.speed = 0
	}
	if tty, err := os.Open("/dev/tty"); err == nil {
		w.tty = tty
		defer tty.Close()
	}
	fmt.Fprint(w.out, "\x1b[?25l")
	defer fmt.Fprint(w.out, "\x1b[?25h")
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, shutdownSignals()...)
	defer signal.Stop(interrupts)
	go func() {
		if _, ok := <-interrupts; ok {
			w.restoreTerminal()
			fmt.Fprint(w.out, "\x1b[?25h\n")
			os.Exit(130)
		}
	}()

	w.intro()
	w.agents()
	w.firstSend()

	_ = os.MkdirAll(filepath.Dir(welcomeMarker()), 0o755)
	_ = os.WriteFile(welcomeMarker(), []byte(cdVersion()+"\n"), 0o644)
	return 0
}

func (w welcome) pause(units int) {
	time.Sleep(time.Duration(units) * w.speed)
}

// typeOut prints text one rune at a time, styled as a whole once complete.
func (w welcome) typeOut(prefix, text string, style func(string) string) {
	if w.speed == 0 {
		fmt.Fprintln(w.out, prefix+style(text))
		return
	}
	fmt.Fprint(w.out, prefix)
	for _, character := range text {
		fmt.Fprint(w.out, style(string(character)))
		w.pause(18)
	}
	fmt.Fprintln(w.out)
}

func (w welcome) heading(step, title string) {
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "  "+accent(step)+"  "+bold(title))
	fmt.Fprintln(w.out, "  "+dim(strings.Repeat("─", 52)))
}

func (w welcome) intro() {
	fmt.Fprint(w.out, "\x1b[2J\x1b[H\n")
	for index, line := range wordmark {
		color := wordmarkColors[index]
		if w.speed == 0 {
			fmt.Fprintln(w.out, "    "+sgr("1;"+color, line))
			continue
		}
		// Sweep each row in from the left.
		runes := []rune(line)
		for end := 0; end <= len(runes); end += 3 {
			if end > len(runes) {
				end = len(runes)
			}
			fmt.Fprint(w.out, "\r    "+sgr("1;"+color, string(runes[:end])))
			w.pause(6)
		}
		fmt.Fprintln(w.out, "\r    "+sgr("1;"+color, line))
	}
	fmt.Fprintln(w.out)
	w.typeOut("    ", "Send any file to any device. Instantly.", bold)
	w.typeOut("    ", "No cloud in the middle, no accounts, no limits on who can receive.", dim)
	fmt.Fprintln(w.out)
	w.pause(250)
	for _, feature := range welcomeFeatures {
		fmt.Fprintf(w.out, "    %s %s%s%s\n", accent("◆"), bold(feature[0]), strings.Repeat(" ", 14-len(feature[0])), dim(feature[1]))
		w.pause(140)
	}
	w.pause(400)
}

func (w welcome) agents() {
	w.heading("01", "Let your AI agents send you files")
	fmt.Fprintln(w.out, "  "+dim("Ask Claude Code, Codex, Gemini or opencode to \"send me the build\""))
	fmt.Fprintln(w.out, "  "+dim("and they reply with a cdx code instead of an upload link."))
	fmt.Fprintln(w.out)

	home, _ := os.UserHomeDir()
	var found []agentTarget
	for _, target := range agentTargets(home) {
		if target.detected() {
			found = append(found, target)
		}
	}
	if len(found) == 0 {
		fmt.Fprintln(w.out, "  "+dim("No agents found on this machine yet. Later, run ")+cmdText("cdx agent setup"))
		return
	}
	var names []string
	for _, target := range found {
		names = append(names, target.name)
	}
	fmt.Fprintln(w.out, "  "+dim("Found: ")+strings.Join(names, dim(", ")))
	fmt.Fprintln(w.out)

	if !w.choose([]string{"Yes, set them up", "Not now"}) {
		fmt.Fprintln(w.out, "  "+dim("Skipped. Run ")+cmdText("cdx agent setup")+dim(" any time."))
		return
	}
	for _, target := range found {
		frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		for index := 0; w.speed > 0 && index < 8; index++ {
			fmt.Fprintf(w.out, "\r  %s %s", accent(frames[index%len(frames)]), target.name)
			w.pause(45)
		}
		where := tildePath(target.path, home)
		if err := target.install(); err != nil {
			fmt.Fprintf(w.out, "\r  %s %s  %s\x1b[K\n", sgr("38;5;203", "✗"), target.name, dim(err.Error()))
			continue
		}
		fmt.Fprintf(w.out, "\r  %s %s  %s\x1b[K\n", green("✓"), target.name, dim(where))
	}
	fmt.Fprintln(w.out, "  "+dim("Undo any time with ")+cmdText("cdx agent remove"))
}

// choose shows an arrow-key menu and reports whether the first option won.
// Without a usable terminal it falls back to a [Y/n] line prompt.
func (w welcome) choose(options []string) bool {
	if w.tty == nil {
		return true
	}
	saved, err := w.stty("-g")
	if err != nil || w.sttySet("-icanon", "-echo", "min", "1") != nil {
		fmt.Fprint(w.out, "  "+options[0]+"? [Y/n] ")
		answer, _ := bufio.NewReader(w.tty).ReadString('\n')
		answer = strings.ToLower(strings.TrimSpace(answer))
		return answer == "" || answer == "y" || answer == "yes"
	}
	savedState = strings.TrimSpace(saved)
	defer w.restoreTerminal()

	selected := 0
	draw := func(first bool) {
		if !first {
			fmt.Fprintf(w.out, "\x1b[%dA", len(options)+1)
		}
		for index, option := range options {
			if index == selected {
				fmt.Fprintf(w.out, "\r  %s %s\x1b[K\n", accent("❯"), bold(option))
			} else {
				fmt.Fprintf(w.out, "\r    %s\x1b[K\n", dim(option))
			}
		}
		fmt.Fprintf(w.out, "\r  %s\x1b[K\n", dim("↑/↓ to move · enter to select"))
	}
	draw(true)
	buffer := make([]byte, 8)
	for {
		count, err := w.tty.Read(buffer)
		if err != nil {
			return false
		}
		key := string(buffer[:count])
		switch key {
		case "\x1b[A", "k":
			selected = (selected + len(options) - 1) % len(options)
		case "\x1b[B", "j", "\t":
			selected = (selected + 1) % len(options)
		case "y", "Y":
			selected = 0
		case "n", "N", "q", "\x1b":
			selected = len(options) - 1
		case "\n", "\r":
		default:
			continue
		}
		draw(false)
		if key == "\n" || key == "\r" || key == "y" || key == "Y" || key == "n" || key == "N" || key == "q" || key == "\x1b" {
			// Collapse the menu into the chosen answer.
			fmt.Fprintf(w.out, "\x1b[%dA\x1b[J", len(options)+1)
			fmt.Fprintf(w.out, "  %s %s\n", accent("❯"), options[selected])
			return selected == 0
		}
	}
}

// savedState is the stty state to restore on exit or Ctrl-C.
var savedState string

func (w welcome) restoreTerminal() {
	if savedState != "" && w.tty != nil {
		_ = w.sttySet(savedState)
		savedState = ""
	}
}

func (w welcome) stty(args ...string) (string, error) {
	command := exec.Command("stty", args...)
	command.Stdin = w.tty
	output, err := command.Output()
	return string(output), err
}

func (w welcome) sttySet(args ...string) error {
	_, err := w.stty(args...)
	return err
}

func (w welcome) firstSend() {
	w.heading("02", "Send your first file")
	w.pause(200)
	w.typeOut("  "+dim("$ "), "cdx send ./photo.jpg", cmdText)
	w.pause(350)
	fmt.Fprintln(w.out)
	box(w.out, 44, []string{
		"",
		dim("SHARE CODE") + "            " + bold(accent(spacedCode("48291"))),
		"",
		bold("photo.jpg") + dim("  ·  2.4 MiB"),
		"",
	})
	w.pause(300)
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "  "+bold("On the other side")+dim(", pick one:"))
	fmt.Fprintln(w.out, "    "+accent("→")+" open "+hyperlink(publicSite(), strings.TrimPrefix(publicSite(), "https://"))+dim(" on any phone or browser and type the code"))
	fmt.Fprintln(w.out, "    "+accent("→")+" or run "+cmdText("cdx receive 48291"))
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "  "+dim("Folders and several files go as one .zip. Need privacy? ")+cmdText("cdx send --link"))
	fmt.Fprintln(w.out)
	w.typeOut("  ", "You're all set. ✦", func(text string) string { return green(bold(text)) })
	fmt.Fprintln(w.out)
}
