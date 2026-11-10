//go:build !windows

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func progressTerminalWidth(file *os.File) int {
	size, err := unix.IoctlGetWinsize(int(file.Fd()), unix.TIOCGWINSZ)
	if err == nil && size.Col > 0 {
		return int(size.Col)
	}
	return 80
}
