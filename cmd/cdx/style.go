package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

// Terminal styling shared by the welcome screen and the share card. Every
// helper degrades to plain text when NO_COLOR is set.

var colorEnabled = os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"

func sgr(code, text string) string {
	if !colorEnabled {
		return text
	}
	return "\x1b[" + code + "m" + text + "\x1b[0m"
}

func bold(text string) string    { return sgr("1", text) }
func dim(text string) string     { return sgr("2", text) }
func accent(text string) string  { return sgr("38;2;229;138;87", text) }
func green(text string) string   { return sgr("38;5;114", text) }
func cmdText(text string) string { return sgr("38;5;223", text) }

// hyperlink wraps text in an OSC 8 link so terminals make it clickable.
func hyperlink(url, text string) string {
	if !colorEnabled {
		return text
	}
	return "\x1b]8;;" + url + "\x1b\\" + text + "\x1b]8;;\x1b\\"
}

// visibleWidth counts runes outside escape sequences.
func visibleWidth(text string) int {
	width := 0
	for index := 0; index < len(text); {
		if text[index] == 0x1b && index+1 < len(text) {
			switch text[index+1] {
			case '[':
				index += 2
				for index < len(text) && (text[index] < 0x40 || text[index] > 0x7e) {
					index++
				}
				index++
				continue
			case ']':
				end := strings.Index(text[index:], "\x1b\\")
				if end < 0 {
					return width
				}
				index += end + 2
				continue
			}
		}
		_, size := utf8.DecodeRuneInString(text[index:])
		index += size
		width++
	}
	return width
}

// box draws lines inside a rounded frame of the given inner width.
func box(output io.Writer, width int, lines []string) {
	edge := dim
	fmt.Fprintln(output, "  "+edge("╭"+strings.Repeat("─", width+6)+"╮"))
	for _, line := range lines {
		padding := width - visibleWidth(line)
		if padding < 0 {
			padding = 0
		}
		fmt.Fprintln(output, "  "+edge("│")+"   "+line+strings.Repeat(" ", padding)+"   "+edge("│"))
	}
	fmt.Fprintln(output, "  "+edge("╰"+strings.Repeat("─", width+6)+"╯"))
}

// spacedCode renders 48291 as "4 8 2 9 1" so it reads aloud easily.
func spacedCode(value string) string {
	return strings.Join(strings.Split(value, ""), " ")
}

// fancyReady is set when the share card replaced the plain stdout line, so the
// sender skips the plain-text hints the card already shows.
var fancyReady bool

// writeReadyCard is the terminal form of writeReady.
func writeReadyCard(output io.Writer, value readyOutput) {
	size := formatShortBytes(value.Size)
	fmt.Fprintln(output)
	if value.Code != "" {
		site := hyperlink(publicSite(), strings.TrimPrefix(publicSite(), "https://"))
		box(output, 44, []string{
			"",
			dim("SHARE CODE") + "            " + bold(accent(spacedCode(value.Code))),
			"",
			bold(shortName(value.Filename, 28)) + dim("  ·  "+size),
			"",
			dim("open ") + site + dim(" and type the code"),
			dim("or run ") + cmdText("cdx receive "+value.Code),
			"",
		})
	} else {
		fmt.Fprintln(output, "  "+accent("◆")+" "+bold("PRIVATE LINK")+dim("  ·  end-to-end encrypted"))
		fmt.Fprintln(output)
		fmt.Fprintln(output, "    "+sgr("4", hyperlink(value.URL, value.URL)))
		fmt.Fprintln(output)
		fmt.Fprintln(output, "  "+bold(shortName(value.Filename, 40))+dim("  ·  "+size))
		fmt.Fprintln(output, "  "+dim("open it in a browser, or run ")+cmdText("cdx receive '<link>'"))
	}
	fmt.Fprintln(output)
	fmt.Fprintln(output, "  "+accent("●")+" "+dim("waiting for the receiver · expires in 15m · Ctrl-C to cancel"))
	fmt.Fprintln(output)
	fancyReady = true
}

func publicSite() string {
	if value := os.Getenv("CD_PUBLIC_URL"); value != "" {
		return strings.TrimRight(value, "/")
	}
	return "https://cd.yash0.in"
}

// shortName keeps long filenames from breaking the card frame.
func shortName(name string, limit int) string {
	runes := []rune(name)
	if len(runes) <= limit {
		return name
	}
	return string(runes[:limit-1]) + "…"
}
