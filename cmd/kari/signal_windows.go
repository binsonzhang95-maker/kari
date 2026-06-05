//go:build windows

package main

import "os"

func resizeSignal() os.Signal {
	return nil
}

func terminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
