//go:build !windows

package syncd

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// BootstrapLocalExecPath returns the PATH the daemon should hand to
// child processes spawned by the local-exec bridge. On macOS, the
// Electron app's syncd inherits a stripped PATH (typically just
// /usr/bin:/bin) because launchd's plist environment is used, not the
// user's shell. Tools the user installed via Homebrew, nvm, asdf,
// rbenv, etc. then aren't reachable — the LLM would call npm and get
// "command not found" even though it's right there in the user's
// terminal.
//
// The fix is to ask the user's login shell once at daemon startup
// what its PATH is and cache the answer. We use the user's $SHELL
// rather than hardcoding zsh because fish / nushell / bash users all
// need their own resolution. We add `-l` (or whatever the shell uses
// for login mode) so .zprofile / .bash_profile / config.fish run.
//
// Best effort: on any failure (timeout, weird shell, sandboxed daemon)
// we fall back to os.Getenv("PATH") and log a warning. The runner can
// then still work for tools that happen to be on the inherited PATH;
// it just can't see the user's customisations.
func BootstrapLocalExecPath() string {
	if env := strings.TrimSpace(os.Getenv("KARI_LOCAL_EXEC_PATH")); env != "" {
		// Operator override, mostly for tests and packaged builds where
		// the daemon already runs under the right shell. Skips the
		// subprocess entirely.
		return env
	}
	shellPath := strings.TrimSpace(os.Getenv("SHELL"))
	if shellPath == "" {
		log.Printf("exec path bootstrap: $SHELL not set, falling back to inherited PATH")
		return os.Getenv("PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	shellName := filepath.Base(shellPath)
	args := loginShellArgs(shellName)
	cmd := exec.CommandContext(ctx, shellPath, args...)
	out, err := cmd.Output()
	if err != nil {
		log.Printf("exec path bootstrap: %s %v failed: %v; falling back to inherited PATH", shellPath, args, err)
		return os.Getenv("PATH")
	}
	got := strings.TrimSpace(string(out))
	if got == "" {
		log.Printf("exec path bootstrap: %s returned empty PATH; falling back to inherited PATH", shellPath)
		return os.Getenv("PATH")
	}
	return got
}

// loginShellArgs picks the right flags to make the named shell run as
// a login + interactive shell so user profile files (.zprofile,
// .bash_profile, fish's config.fish, etc.) execute and the resulting
// $PATH is what `which npm` would see in a terminal.
func loginShellArgs(shellName string) []string {
	switch shellName {
	case "fish":
		// fish needs `-i -c` for interactive sourcing of config.fish.
		return []string{"-i", "-c", "echo $PATH"}
	case "nu", "nushell":
		// nushell doesn't support -i; -c runs a single command in
		// "engine state" mode which reads config.nu.
		return []string{"-c", "echo $env.PATH"}
	default:
		// zsh, bash, ksh, dash: -ilc = interactive + login + command.
		// Interactive flag is what makes zsh source .zshrc; login is
		// what sources .zprofile / .profile. We need both because
		// nvm/asdf hooks typically live in .zshrc.
		return []string{"-ilc", "echo $PATH"}
	}
}
