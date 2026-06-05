//go:build !windows

package filesync

import (
	"fmt"
	"os"
	"syscall"
)

func fileID(info os.FileInfo) string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
}
