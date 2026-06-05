package remoteexec

import (
	"runtime"
	"strings"
)

// prepareShellEnv returns the environment slice that should be handed to
// a child shell (interactive or one-shot). It branches by GOOS so that
// the same call sites stay simple:
//
//   - POSIX (linux/darwin/...): inject UTF-8 LANG/LC_* so non-ASCII
//     output from tools like `ls` renders correctly when the host inherits
//     a C/POSIX locale.
//   - Windows: actively *strip* LANG/LC_* if they happen to be set on the
//     server process. A user-launched PowerShell never has these, so
//     leaving them in is a giveaway that the session was spawned by a
//     non-PowerShell parent (i.e. our server). UTF-8 on Windows is handled
//     by ConPTY + PowerShell's own [Console]::OutputEncoding, not by
//     POSIX locale variables.
func prepareShellEnv(env []string) []string {
	if runtime.GOOS == "windows" {
		return stripPosixLocale(env)
	}
	return withUTF8Locale(env)
}

// stripPosixLocale drops POSIX locale variables (LANG/LC_*) from `env`.
// Used on Windows to avoid leaking a fingerprint that distinguishes our
// PowerShell session from one the user would have opened themselves.
func stripPosixLocale(env []string) []string {
	drop := map[string]struct{}{
		"LANG":        {},
		"LC_ALL":      {},
		"LC_CTYPE":    {},
		"LC_MESSAGES": {},
	}
	out := make([]string, 0, len(env))
	for _, kv := range env {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			out = append(out, kv)
			continue
		}
		if _, hit := drop[kv[:eq]]; hit {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// withUTF8Locale returns a copy of `env` with UTF-8 locale variables
// either added (if missing) or rewritten (if they currently advertise a
// non-UTF-8 charset). Only the LANG/LC_* variables are touched.
func withUTF8Locale(env []string) []string {
	const fallback = "en_US.UTF-8"
	want := map[string]string{
		"LANG":        fallback,
		"LC_ALL":      fallback,
		"LC_CTYPE":    fallback,
		"LC_MESSAGES": fallback,
	}
	out := make([]string, 0, len(env)+len(want)+1)
	for _, kv := range env {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			out = append(out, kv)
			continue
		}
		k, v := kv[:eq], kv[eq+1:]
		// Strip any inherited TERM; we re-add a known-safe value below
		// so VS Code's xterm.js never sees a kitty-keyboard-capable
		// advertisement from a TUI running through the PTY.
		if k == "TERM" {
			_ = v
			continue
		}
		if k == "COLORTERM" {
			// Drop inherited COLORTERM too — we always re-add truecolor.
			continue
		}
		if _, isLocale := want[k]; isLocale {
			// Keep the existing value only if it already declares UTF-8.
			if strings.Contains(strings.ToLower(v), "utf-8") || strings.Contains(strings.ToLower(v), "utf8") {
				delete(want, k)
				out = append(out, kv)
				continue
			}
			// Otherwise drop it; we re-add a UTF-8 version below.
			continue
		}
		out = append(out, kv)
	}
	for k, v := range want {
		out = append(out, k+"="+v)
	}
	// When trans-server is launched non-interactively (launchd/systemd,
	// or detached from any tty), TERM is empty in the inherited env.
	// Bash/readline keys arrow keys + backspace off terminfo lookup on
	// $TERM, so an empty TERM degrades the remote shell into a "literal
	// escape sequence" mode where ←/→/↑/↓/⌫ all echo as garbage.
	//
	// We deliberately use screen-256color rather than xterm-256color
	// here. Rust TUI stacks (ratatui/crossterm) used by codex/claude-cli
	// treat xterm-256color as "kitty keyboard protocol probably works"
	// and start sending `CSI ? u` queries plus `CSI <flags> u` push-mode
	// commands. VS Code's integrated terminal (xterm.js) does NOT
	// implement that protocol — it neither answers the query nor
	// consumes the push commands, so those `ESC[13u`-style bytes leak
	// onto the user's screen as garbage. screen-256color keeps full
	// 256-color and UTF-8 support but signals "legacy keyboard only",
	// which steers those TUIs onto the well-trodden ANSI input path.
	out = append(out, "TERM=screen-256color")
	// COLORTERM keeps truecolor working for tools that look here
	// independently of TERM (most modern color-aware Rust crates do).
	out = append(out, "COLORTERM=truecolor")
	return out
}
