// Package redact provides best-effort credential scrubbing for
// git URLs that appear in server-side logs or are reflected back to
// clients in bootstrap result envelopes.
package redact

import (
	"strings"
)

// URL replaces the userinfo portion of a URL (user:pass@host) with
// `***` so log lines and audit trails never leak credentials. Best-
// effort: returns input unchanged if there's no scheme:// or no @.
func URL(raw string) string {
	if raw == "" {
		return ""
	}
	idx := strings.Index(raw, "://")
	if idx < 0 {
		return raw
	}
	scheme := raw[:idx+3]
	rest := raw[idx+3:]
	at := strings.Index(rest, "@")
	if at < 0 {
		return raw
	}
	return scheme + "***@" + rest[at+1:]
}

// Bytes scrubs occurrences of a literal git URL inside arbitrary
// stdout/stderr output by replacing its userinfo with ***. Returns at
// most the last ~4 KB of the input so the result stays cheap to ship
// over the wire inside bootstrap result envelopes.
func Bytes(out []byte, originalURL string) string {
	const tailLen = 4096
	tail := out
	if len(out) > tailLen {
		tail = out[len(out)-tailLen:]
	}
	s := string(tail)
	if originalURL != "" {
		s = strings.ReplaceAll(s, originalURL, URL(originalURL))
	}
	return s
}
