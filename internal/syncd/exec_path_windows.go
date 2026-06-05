//go:build windows

package syncd

import "os"

// BootstrapLocalExecPath on Windows is a no-op that just returns the
// inherited PATH. Windows doesn't have the "stripped PATH inside the
// Electron-launched daemon" problem because PATH is constructed from
// the user / machine environment registry and inherited verbatim; no
// login-shell-vs-GUI gap to plug. Also: localExecPlatformSupported()
// is false on Windows in v1 so this isn't on the hot path.
func BootstrapLocalExecPath() string {
	return os.Getenv("PATH")
}
