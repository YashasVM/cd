//go:build !windows

package main

import (
	"errors"
	"syscall"
)

// detachAttributes starts the holder in its own session, so it survives the
// caller's shell, terminal, and process-group cleanup.
func detachAttributes() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// terminateProcess asks a background holder to stop with SIGTERM, which the
// holder's shutdown-signal context turns into a "transfer canceled" state.
func terminateProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}
