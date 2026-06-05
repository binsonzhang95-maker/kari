package syncd

import (
	"net"
	"runtime"
	"time"
)

// SSHStatus reports whether port 22 is accepting connections locally
// and whether this OS supports a one-click install path the ext can
// offer. It's a cheap snapshot used by the sidebar to decide:
//   - Show a green "SSH available" dot, or
//   - Show an "Install SSH service" button (Windows only — Add-
//     WindowsCapability), or
//   - Show a "Open Sharing settings" link (macOS — Remote Login
//     toggle requires TCC, can't be flipped from code).
type SSHStatus struct {
	Available        bool   `json:"available"`
	Port             int    `json:"port"`
	Platform         string `json:"platform"`
	InstallSupported bool   `json:"install_supported"`
}

// ProbeSSHStatus dials 127.0.0.1:22 with a tight timeout. We don't
// need an SSH handshake — a successful TCP connect proves something
// is listening, and that's all the sidebar needs to display "SSH
// is reachable on this machine". For deeper inspection (sshd
// service state) we'd shell out to platform-specific tools
// (`sc.exe query sshd` / `launchctl list com.openssh.sshd`); deferred
// until we have a concrete need beyond the binary green/red dot.
func ProbeSSHStatus() SSHStatus {
	st := SSHStatus{
		Port:     22,
		Platform: runtime.GOOS,
		// Only Windows has a non-interactive elevation path
		// (Add-WindowsCapability) we can drive from a script.
		// macOS Remote Login is behind TCC; Linux varies by distro.
		InstallSupported: runtime.GOOS == "windows",
	}
	conn, err := net.DialTimeout("tcp", "127.0.0.1:22", 800*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		st.Available = true
	}
	return st
}
