//go:build windows

package filesync

import "os"

func fileID(info os.FileInfo) string {
	return ""
}
