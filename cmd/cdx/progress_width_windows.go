package main

import (
	"os"

	"golang.org/x/sys/windows"
)

func progressTerminalWidth(file *os.File) int {
	var info windows.ConsoleScreenBufferInfo
	if windows.GetConsoleScreenBufferInfo(windows.Handle(file.Fd()), &info) == nil {
		return int(info.Window.Right-info.Window.Left) + 1
	}
	return 80
}
