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

// wordmarkColors follows the warm accent used by the share card.
var wordmarkColors = []string{"38;2;255;218;171", "38;2;250;199;146", "38;2;244;178;121", "38;2;237;158;101", "38;2;229;138;87", "38;2;205;113;73"}

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
	w := welcome{out: os.Stdout, speed: 400 * time.Microsecond}
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
	if isTerminal(os.Stdout) {
		fmt.Fprint(w.out, "\x1b[?25l")
		defer fmt.Fprint(w.out, "\x1b[?25h")
	}
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
	fmt.Fprintln(w.out, "  "+sgr("1;38;2;229;138;87", step+" / 02")+"  "+bold(title))
	fmt.Fprintln(w.out, "  "+dim(strings.Repeat("─", 52)))
	fmt.Fprintln(w.out)
}

func (w welcome) intro() {
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "    "+accent("GETTING STARTED")+dim("  /  cdx"))
	fmt.Fprintln(w.out)
	for index, line := range wordmark {
		color := wordmarkColors[index]
		if w.speed == 0 {
			fmt.Fprintln(w.out, "    "+sgr("1;"+color, line))
			continue
		}
		runes := []rune(line)
		for end := 0; end < len(runes); end += 3 {
			fmt.Fprint(w.out, "\r    "+sgr("1;"+color, string(runes[:end])))
			w.pause(6)
		}
		fmt.Fprintln(w.out, "\r    "+sgr("1;"+color, line))
	}
	fmt.Fprintln(w.out)
	w.typeOut("    ", "Your files. Any device.", bold)
	w.typeOut("    ", "Send a file. Share a code. Open it on the other side.", dim)
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "    "+accent("●")+" "+bold("No accounts")+dim("  ·  phone, browser, or terminal"))
	fmt.Fprintln(w.out, "    "+accent("●")+" "+bold("Peer to peer")+dim("  ·  relay when a direct path fails"))
	fmt.Fprintln(w.out, "    "+accent("●")+" "+bold("Private links")+dim("  ·  end-to-end encryption with --link"))
	w.pause(200)
}

func (w welcome) agents() {
	w.heading("01", "Connect your AI agents")
	fmt.Fprintln(w.out, "    "+dim("Ask your agent to send a file. Get a download link."))
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "    "+accent("❯")+" "+bold("\"Send me the build with cdx\""))
	fmt.Fprintln(w.out)

	home, _ := os.UserHomeDir()
	var found []agentTarget
	for _, target := range agentTargets(home) {
		if target.detected() {
			found = append(found, target)
		}
	}
	if len(found) == 0 {
		fmt.Fprintln(w.out, "    "+dim("No supported agents found. You can set them up later:"))
		fmt.Fprintln(w.out, "    "+cmdText("cdx agent setup"))
		return
	}
	var names []string
	for _, target := range found {
		names = append(names, target.name)
	}
	fmt.Fprintln(w.out, "    "+dim("Detected on this machine"))
	for _, name := range names {
		fmt.Fprintln(w.out, "    "+green("✓")+" "+name)
	}
	fmt.Fprintln(w.out)

	if !w.choose([]string{"Set up file sharing", "Skip for now"}) {
		fmt.Fprintln(w.out, "    "+dim("Run ")+cmdText("cdx agent setup")+dim(" any time."))
		return
	}
	for _, target := range found {
		frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		for index := 0; w.speed > 0 && index < 8; index++ {
			fmt.Fprintf(w.out, "\r    %s %s", accent(frames[index%len(frames)]), target.name)
			w.pause(45)
		}
		where := tildePath(target.path, home)
		if err := target.install(); err != nil {
			fmt.Fprintf(w.out, "\r    %s %s  %s\x1b[K\n", sgr("38;5;203", "✗"), target.name, dim(err.Error()))
			continue
		}
		fmt.Fprintf(w.out, "\r    %s %s  %s\x1b[K\n", green("✓"), target.name, dim(where))
	}
	fmt.Fprintln(w.out, "    "+dim("Undo any time with ")+cmdText("cdx agent remove"))
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
				fmt.Fprintf(w.out, "\r    %s %s\x1b[K\n", accent("❯"), bold(option))
			} else {
				fmt.Fprintf(w.out, "\r      %s\x1b[K\n", dim(option))
			}
		}
		fmt.Fprintf(w.out, "\r    %s\x1b[K\n", dim("↑/↓ choose   enter confirm"))
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
			fmt.Fprintf(w.out, "    %s %s\n", accent("❯"), options[selected])
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
	w.typeOut("    "+dim("$ "), "cdx send ./photo.jpg", cmdText)
	fmt.Fprintln(w.out)
	w.pause(200)
	box(w.out, 44, []string{
		"",
		dim("EXAMPLE TRANSFER"),
		bold("photo.jpg") + dim("  ·  2.4 MiB"),
		"",
		dim("SHARE CODE") + "   " + bold(accent(spacedCode("48291"))),
		"",
		dim("15 minutes to connect · one receiver"),
		"",
	})
	w.pause(200)
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "    "+bold("Receive in your browser"))
	fmt.Fprintln(w.out, "    Open "+hyperlink(publicSite(), strings.TrimPrefix(publicSite(), "https://"))+dim(" and enter the code."))
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "    "+bold("Or in another terminal"))
	fmt.Fprintln(w.out, "    "+dim("$ ")+cmdText("cdx receive 48291"))
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "    "+dim("Folders and multiple files arrive as one .zip."))
	fmt.Fprintln(w.out, "    "+dim("For a private link: ")+cmdText("cdx send --link ./photo.jpg"))
	fmt.Fprintln(w.out)
	fmt.Fprintln(w.out, "  "+dim(strings.Repeat("─", 52)))
	w.typeOut("    "+green("✓ "), "You're ready to share.", bold)
	fmt.Fprintln(w.out, "    "+dim("More commands: ")+cmdText("cdx help"))
	fmt.Fprintln(w.out)
}
