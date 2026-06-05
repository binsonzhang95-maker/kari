//go:build !windows

package main

import (
	"os"
	"syscall"
)

func resizeSignal() os.Signal {
	return syscall.SIGWINCH
}

func terminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}
}
