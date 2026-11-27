//go:build windows

package main

import (
	"os"
	"syscall"
)

const (
	detachedProcess                = 0x00000008
	createBreakawayFromJob         = 0x01000000
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
)

// detachAttributes starts the holder without a console in a new process
// group, so it survives the caller's console closing.
func detachAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP, HideWindow: true}
}

// detachAttributesList returns process-creation attributes to try in order
// when launching a background holder. Breaking away from a parent Job Object
// keeps the holder alive when an agent runner or shell closes its job on exit,
// falling back to standard detachment when breakaway is not permitted.
func detachAttributesList() []*syscall.SysProcAttr {
	return []*syscall.SysProcAttr{
		{CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP | createBreakawayFromJob, HideWindow: true},
		detachAttributes(),
	}
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

// terminateProcess stops a background holder by killing its process.
func terminateProcess(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}
