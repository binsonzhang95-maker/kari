// Package ptyinput intercepts bracketed-paste sequences flowing into
// the remote PTY's stdin and turns dragged-image local paths into
// uploads + remote-path pastes. The package is split into:
//
//	parse.go     — payload parsing, image extension whitelist
//	sniffer.go   — bracketed-paste state machine
//	uploader.go  — HTTP client that talks to kari-syncd /v1/pty-attach
//
// The whole subsystem is best-effort: anything we can't confidently
// classify as a dragged image gets forwarded verbatim so the user
// retains the normal "paste lands as text" behaviour.
package ptyinput

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// attachImageExts mirrors the server-side (and Claude Code's) accepted
// image extensions. Keeping the list duplicated here lets the client
// short-circuit obviously-uninteresting pastes without round-tripping
// to the daemon.
var attachImageExts = map[string]struct{}{
	".png":  {},
	".jpg":  {},
	".jpeg": {},
	".gif":  {},
	".webp": {},
}

// hasImageExt reports whether path's extension is one we'll try to
// auto-upload. Case-insensitive match against attachImageExts.
func hasImageExt(path string) bool {
	_, ok := attachImageExts[strings.ToLower(filepath.Ext(path))]
	return ok
}

// parseDroppedPath inspects the body of a bracketed paste and tries to
// extract a single absolute local file path that the OS file picker
// (or a Finder/Explorer drag) would have produced. Returns (path, true)
// only when the payload is unambiguously a path; the caller then
// stat-checks before treating it as a real drop. ok=false means
// "forward this paste unchanged."
//
// Heuristics applied, in order:
//   1. Reject any payload containing newlines, NUL, or control bytes
//      other than tab/space — a real drag yields a single line.
//   2. Trim surrounding whitespace.
//   3. Strip one matching pair of surrounding quotes (single, double,
//      or backtick) — macOS Finder quotes paths with spaces, Windows
//      Explorer always wraps in double quotes.
//   4. URL-decode and strip `file://` if present.
//   5. Replace POSIX shell-escape sequences (`\ `, `\(`, etc.) with
//      their literal counterparts — macOS Terminal drag emits these
//      when bracketed-paste mode is off, but the same shape sometimes
//      leaks through under VS Code's terminal too.
//   6. On Windows-looking payloads (drive letter + colon), collapse
//      doubled backslashes (`\\` → `\`) — Explorer drag does this.
//   7. Require filepath.IsAbs after cleaning.
func parseDroppedPath(payload []byte) (string, bool) {
	if len(payload) == 0 {
		return "", false
	}
	for _, b := range payload {
		if b == '\n' || b == '\r' || b == 0x00 {
			return "", false
		}
		// Other C0 controls (tab and below) are unexpected in drag
		// payloads — bail rather than guess.
		if b < 0x20 && b != '\t' {
			return "", false
		}
	}
	s := strings.TrimSpace(string(payload))
	if s == "" {
		return "", false
	}
	s = stripPairedQuotes(s)
	if strings.HasPrefix(strings.ToLower(s), "file://") {
		// file:///Users/foo (macOS) or file:///C:/Users/foo (Windows).
		rest := s[len("file://"):]
		// On Windows, the URL form is file:///C:/... — the leading
		// slash before the drive letter is spurious from a Windows
		// path perspective. Strip it so the filepath.IsAbs check
		// below still sees a native-form absolute path.
		if len(rest) > 3 && rest[0] == '/' && rest[2] == ':' {
			rest = rest[1:]
		}
		if dec, err := url.PathUnescape(rest); err == nil {
			s = dec
		} else {
			s = rest
		}
	}
	// POSIX shell-escape unescaping (only meaningful on macOS/Linux).
	// Cheap heuristic: only run when the path doesn't look Windows-y,
	// to avoid mauling `C:\Users\me` (which contains `\U`).
	if !looksLikeWindowsPath(s) {
		s = unescapePOSIXShell(s)
	} else {
		// Explorer drag may double up backslashes (`C:\\Users\\me`).
		// Collapse them but only after we've confirmed Windows shape.
		s = strings.ReplaceAll(s, "\\\\", "\\")
	}
	s = filepath.Clean(s)
	if !filepath.IsAbs(s) {
		return "", false
	}
	return s, true
}

// stripPairedQuotes removes a single matching pair of surrounding
// quote characters. Only strips when both ends match — leaves
// `"foo` and `bar"` alone since those are almost certainly typed text.
func stripPairedQuotes(s string) string {
	if len(s) < 2 {
		return s
	}
	first, last := s[0], s[len(s)-1]
	if first == last && (first == '"' || first == '\'' || first == '`') {
		return s[1 : len(s)-1]
	}
	return s
}

// unescapePOSIXShell undoes the backslash-prefix escaping that macOS
// emits for spaces and shell metacharacters when dragging a file into
// a terminal that doesn't have bracketed-paste mode on. Conservative:
// only unescapes the small set of characters Finder actually escapes.
func unescapePOSIXShell(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\\' && i+1 < len(s) {
			n := s[i+1]
			switch n {
			case ' ', '(', ')', '[', ']', '{', '}', '\'', '"', '`', '$', '&', ';', '|', '<', '>', '!', '#', '?', '*', '~':
				b.WriteByte(n)
				i++
				continue
			}
		}
		b.WriteByte(c)
	}
	return b.String()
}

// looksLikeWindowsPath reports whether s starts with a drive-letter
// prefix like `C:\` or `C:/`. Used to decide which unescape strategy
// to apply.
func looksLikeWindowsPath(s string) bool {
	if len(s) < 3 {
		return false
	}
	c := s[0]
	if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
		return false
	}
	return s[1] == ':' && (s[2] == '\\' || s[2] == '/')
}

// localFileIsRegular returns true if path exists and is a regular
// file. Wraps os.Lstat for testability and to centralise the "drag
// can't be a directory/symlink" rule.
func localFileIsRegular(path string) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	return info.Mode().IsRegular()
}
