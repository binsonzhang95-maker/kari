//go:build !windows

package main

import (
	"log"
	"syscall"
)

// raiseFileLimit bumps the process's RLIMIT_NOFILE soft cap as high as
// the kernel will allow. The local daemon owns the client-side filesystem
// watcher, so it needs the same protection as trans-server against
// launchd's low default fd limit on macOS.
func raiseFileLimit() {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		log.Printf("rlimit: getrlimit: %v", err)
		return
	}
	start := rl.Cur
	for _, target := range []uint64{1 << 20, 65536, 32768, 16384, 10240, 4096} {
		if target <= rl.Cur {
			break
		}
		rl.Cur = target
		if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &rl); err == nil {
			log.Printf("rlimit: NOFILE soft cap raised %d -> %d", start, target)
			return
		}
	}
	log.Printf("rlimit: could not raise NOFILE soft cap (still %d)", start)
}
