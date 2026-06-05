package execpolicy

import (
	"os"
	"time"
)

// bumpMtime forces a later modification time on path. Used by the
// hot-reload test because os.WriteFile twice in quick succession can
// land in the same second on filesystems with low-resolution mtime
// (e.g. some ext4 mount options, older HFS+), making the Loader's
// sameStat short-circuit hide the change. We add 2s deliberately so
// the test is robust on those filesystems.
func bumpMtime(path string) error {
	stat, err := os.Stat(path)
	if err != nil {
		return err
	}
	newTime := stat.ModTime().Add(2 * time.Second)
	return os.Chtimes(path, newTime, newTime)
}
