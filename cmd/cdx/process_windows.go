//go:build windows

package main

import "syscall"

const (
	detachedProcess                = 0x00000008
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
)

// detachAttributes starts the holder without a console in a new process
// group, so it survives the caller's console closing.
func detachAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP, HideWindow: true}
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == stillActive
}
