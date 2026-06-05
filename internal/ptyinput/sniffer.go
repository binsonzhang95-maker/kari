package ptyinput

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"time"
)

// pasteBegin and pasteEnd are the standard bracketed-paste delimiters
// the remote shell turns on with DECSET 2004. VS Code's terminal wraps
// dragged file paths in this when the active program has the mode on.
var (
	pasteBegin = []byte{0x1b, '[', '2', '0', '0', '~'}
	pasteEnd   = []byte{0x1b, '[', '2', '0', '1', '~'}
)

// Options configures the Sniffer. All fields are required when Attach
// is true; if Attach is false, the sniffer just forwards bytes
// verbatim.
type Options struct {
	// MaxPasteBytes caps how much in-paste data we'll buffer before
	// giving up and forwarding verbatim. 64 KB comfortably covers any
	// realistic drop path while preventing a misbehaving peer from
	// holding the sniffer hostage on a long paste.
	MaxPasteBytes int
	// Attach toggles the whole interception flow. When false, Feed
	// is a thin passthrough to Forward.
	Attach bool
	// Uploader handles the local→remote round-trip when a drop is
	// detected. Nil disables interception (same effect as Attach=false).
	Uploader Uploader
	// LocalDiag receives transient status lines like "Uploading…" /
	// "Uploaded → …". Wire this to os.Stderr so VS Code renders the
	// messages locally — anything written here does NOT enter the
	// encrypted PTY stream.
	LocalDiag io.Writer
	// Forward is the actual "send to remote PTY" function. The sniffer
	// calls it with every byte it decides not to intercept, including
	// re-emitting an unrecognized paste verbatim (markers included).
	Forward func(b []byte) error
	// AttachTimeout caps the whole upload round-trip. 45 s lets a
	// chunky photo over a flaky link land while still failing closed
	// for genuinely stuck cases.
	AttachTimeout time.Duration
	// RemoteWorkDir is the server-side workspace path the recv loop
	// has stored via MessagePtyStart (same atomic pointer
	// HTTPUploader.waitForWorkDir polls). When non-nil and the pasted
	// path starts with the stored value, the sniffer treats the path
	// as "already on the server" — Desktop's new direct-upload bypass
	// (/api/v1/pty/clipboard-paste) returns paths that DO exist on
	// the local filesystem in single-host dev setups, so the legacy
	// localFileIsRegular check would otherwise round-trip them
	// through /v1/pty-attach a second time. forwardOriginal lets the
	// remote PTY consume the path directly.
	RemoteWorkDir *atomic.Pointer[string]
}

// Sniffer drives a small state machine over the PTY stdin byte stream
// to detect bracketed pastes that look like dragged-image paths.
type Sniffer struct {
	opts  Options
	state ssState
	// pasteBuf accumulates the bytes between BEGIN and END markers.
	pasteBuf []byte
	// boundary holds the longest unmatched prefix of a marker we've
	// seen at the tail of a Feed buffer. We need this because the
	// marker can split across two Reads — `\x1b[20` then `0~rest`.
	// At most 6 bytes (the marker length minus 1).
	boundary []byte
}

type ssState int

const (
	stateIdle ssState = iota
	stateInsidePaste
)

// NewSniffer constructs a Sniffer with sane defaults filled in for
// any zero-valued option fields.
func NewSniffer(opts Options) *Sniffer {
	if opts.MaxPasteBytes <= 0 {
		opts.MaxPasteBytes = 64 * 1024
	}
	if opts.AttachTimeout <= 0 {
		opts.AttachTimeout = 45 * time.Second
	}
	if opts.LocalDiag == nil {
		opts.LocalDiag = io.Discard
	}
	if opts.Forward == nil {
		opts.Forward = func([]byte) error { return nil }
	}
	return &Sniffer{opts: opts}
}

// Feed processes one chunk of stdin bytes. Bytes that belong to a
// recognized paste get accumulated; everything else is forwarded
// immediately. Returns the first forwarding error.
func (s *Sniffer) Feed(p []byte) error {
	if !s.opts.Attach || s.opts.Uploader == nil {
		return s.opts.Forward(p)
	}
	// Prepend any unresolved tail from the previous Feed.
	if len(s.boundary) > 0 {
		buf := make([]byte, 0, len(s.boundary)+len(p))
		buf = append(buf, s.boundary...)
		buf = append(buf, p...)
		s.boundary = s.boundary[:0]
		p = buf
	}

	i := 0
	for i < len(p) {
		switch s.state {
		case stateIdle:
			// Scan for the start of a BEGIN marker.
			next := indexEsc(p, i)
			if next < 0 {
				if err := s.opts.Forward(p[i:]); err != nil {
					return err
				}
				return nil
			}
			// Flush bytes before the ESC.
			if next > i {
				if err := s.opts.Forward(p[i:next]); err != nil {
					return err
				}
			}
			i = next
			// Try to match BEGIN at i.
			match, complete := matchPrefix(p[i:], pasteBegin)
			if !complete {
				if match > 0 {
					// Partial marker at tail; stash and stop.
					s.boundary = append(s.boundary[:0], p[i:]...)
					return nil
				}
				// Not a paste marker. Forward the ESC together with
				// the run of bytes up to (but not including) the next
				// ESC, so a complete escape sequence like an arrow key
				// (`\x1b[D`) reaches the remote PTY in a single write.
				// Forwarding the lone ESC and then `[D` as two separate
				// MessagePtyInputs splits them by a network round-trip;
				// crossterm/codex's input parser sees the bare ESC, the
				// follow-up doesn't arrive in time, it decides the user
				// pressed Escape, and prints `[D`/`[C`/`[B`/`[A` as
				// literal text.
				end := i + 1
				for end < len(p) && p[end] != 0x1b {
					end++
				}
				if err := s.opts.Forward(p[i:end]); err != nil {
					return err
				}
				i = end
				continue
			}
			// Full BEGIN matched.
			i += len(pasteBegin)
			s.state = stateInsidePaste
			s.pasteBuf = s.pasteBuf[:0]

		case stateInsidePaste:
			// Look for END marker. Track partial matches at buffer tail.
			endIdx := indexEsc(p, i)
			if endIdx < 0 {
				// No ESC; accumulate everything remaining (subject to cap).
				if err := s.accumulate(p[i:]); err != nil {
					return err
				}
				return nil
			}
			// Accumulate bytes before the candidate END.
			if endIdx > i {
				if err := s.accumulate(p[i:endIdx]); err != nil {
					return err
				}
			}
			i = endIdx
			match, complete := matchPrefix(p[i:], pasteEnd)
			if !complete {
				if match > 0 {
					// Partial END at tail; stash and stop. The
					// stashed bytes are still considered "inside" —
					// pasteBuf keeps what we have, and the next Feed
					// will re-evaluate from the boundary.
					s.boundary = append(s.boundary[:0], p[i:]...)
					return nil
				}
				// Solo ESC inside a paste; accumulate the byte and move on.
				if err := s.accumulate(p[i : i+1]); err != nil {
					return err
				}
				i++
				continue
			}
			// Full END matched. Hand the paste off for classification.
			i += len(pasteEnd)
			payload := append([]byte(nil), s.pasteBuf...)
			s.pasteBuf = s.pasteBuf[:0]
			s.state = stateIdle
			if err := s.handlePaste(payload); err != nil {
				return err
			}
		}
	}
	return nil
}

// Flush is called at EOF: anything still buffered gets forwarded as-is
// so the remote shell isn't deprived of bytes the user typed.
func (s *Sniffer) Flush() error {
	if len(s.boundary) > 0 {
		if err := s.opts.Forward(s.boundary); err != nil {
			return err
		}
		s.boundary = s.boundary[:0]
	}
	if s.state == stateInsidePaste && len(s.pasteBuf) > 0 {
		// Re-emit the in-flight paste verbatim including the BEGIN marker
		// we already swallowed. End marker will follow only if the user
		// types it; either way the remote sees a faithful copy.
		merged := append([]byte(nil), pasteBegin...)
		merged = append(merged, s.pasteBuf...)
		s.pasteBuf = s.pasteBuf[:0]
		s.state = stateIdle
		return s.opts.Forward(merged)
	}
	return nil
}

// accumulate appends to pasteBuf, bailing out (by re-emitting the
// paste so far as raw bytes) if we exceed MaxPasteBytes — that's how
// we degrade gracefully on a pathologically large in-paste payload.
func (s *Sniffer) accumulate(b []byte) error {
	if len(s.pasteBuf)+len(b) <= s.opts.MaxPasteBytes {
		s.pasteBuf = append(s.pasteBuf, b...)
		return nil
	}
	// Overflow: forward what we have plus the new bytes verbatim,
	// with the BEGIN marker restored, and drop back to idle.
	merged := append([]byte(nil), pasteBegin...)
	merged = append(merged, s.pasteBuf...)
	merged = append(merged, b...)
	s.pasteBuf = s.pasteBuf[:0]
	s.state = stateIdle
	return s.opts.Forward(merged)
}

// handlePaste decides whether the paste body is a draggable image we
// should upload or just regular pasted text to forward unchanged.
//
// Paths inside the remote workspace tree (RemoteWorkDir) short-circuit
// to forwardOriginal — those came from Desktop's direct-upload bypass
// or from a previous /v1/pty-attach round, so they're already on the
// server. The localFileIsRegular check below would otherwise produce a
// false positive in single-host dev setups where the host filesystem
// mirrors the container's view.
func (s *Sniffer) handlePaste(payload []byte) error {
	path, ok := parseDroppedPath(payload)
	if !ok || !hasImageExt(path) {
		return s.forwardOriginal(payload)
	}
	if s.pathInsideRemoteWorkDir(path) {
		return s.forwardOriginal(payload)
	}
	if !localFileIsRegular(path) {
		return s.forwardOriginal(payload)
	}
	return s.attemptUpload(path, payload)
}

// pathInsideRemoteWorkDir returns true when the pasted path lies under
// the server-echoed workspace root. Uses prefix matching plus an
// explicit path-boundary check so a path like /workspaces/wid-evil/
// doesn't accidentally match a workspace at /workspaces/wid/.
func (s *Sniffer) pathInsideRemoteWorkDir(path string) bool {
	if s.opts.RemoteWorkDir == nil {
		return false
	}
	ptr := s.opts.RemoteWorkDir.Load()
	if ptr == nil || *ptr == "" {
		return false
	}
	wd := *ptr
	// Both POSIX (`/`) and Windows (`\`) boundaries — the kari CLI
	// runs on Desktop's OS but RemoteWorkDir is the server's OS form,
	// so accept either separator at the boundary.
	if path == wd {
		return true
	}
	if strings.HasPrefix(path, wd+"/") || strings.HasPrefix(path, wd+`\`) {
		return true
	}
	return false
}

// forwardOriginal re-emits a paste verbatim (including its delimiters).
// Used whenever we decide not to intercept.
func (s *Sniffer) forwardOriginal(payload []byte) error {
	merged := make([]byte, 0, len(pasteBegin)+len(payload)+len(pasteEnd))
	merged = append(merged, pasteBegin...)
	merged = append(merged, payload...)
	merged = append(merged, pasteEnd...)
	return s.opts.Forward(merged)
}

// attemptUpload runs the local→remote upload flow. On any failure we
// forward the original paste so the user still sees the dragged path
// in the terminal — better to give them the local path than nothing.
//
// Diagnostics go to LocalDiag only on failure: Claude Code (and any
// other ANSI-redrawing TUI) constantly repaints the prompt area, so
// even short status writes during a successful upload get visually
// chopped by the redraw and look like glitches. Silent success is
// the lesser evil; failure stays loud because the user otherwise
// has no idea why their image didn't attach.
func (s *Sniffer) attemptUpload(localPath string, originalPayload []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), s.opts.AttachTimeout)
	defer cancel()
	remoteAbspath, err := s.opts.Uploader.Upload(ctx, localPath)
	if err != nil {
		fmt.Fprintf(s.opts.LocalDiag, "\r\n[kari] image upload failed: %v\r\n", err)
		return s.forwardOriginal(originalPayload)
	}
	out := make([]byte, 0, len(pasteBegin)+len(remoteAbspath)+len(pasteEnd))
	out = append(out, pasteBegin...)
	out = append(out, remoteAbspath...)
	out = append(out, pasteEnd...)
	return s.opts.Forward(out)
}

// indexEsc returns the index of the next ESC (0x1b) byte at or after
// start, or -1 if none.
func indexEsc(p []byte, start int) int {
	for i := start; i < len(p); i++ {
		if p[i] == 0x1b {
			return i
		}
	}
	return -1
}

// matchPrefix reports how many bytes of `want` match at the start of
// `got`, and whether the full marker is present. (matched, complete).
// Used for both full-marker detection and boundary-spanning partials.
func matchPrefix(got, want []byte) (int, bool) {
	n := len(got)
	if n > len(want) {
		n = len(want)
	}
	for i := 0; i < n; i++ {
		if got[i] != want[i] {
			return 0, false
		}
	}
	return n, n == len(want)
}
