package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func resolveMCPRuntimeRoot() string {
	if xdg := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR")); xdg != "" {
		return filepath.Join(xdg, "kari-mcp")
	}
	return filepath.Join("/tmp", fmt.Sprintf("kari-mcp-%d", os.Getuid()))
}
