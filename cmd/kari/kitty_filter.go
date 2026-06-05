package main

// kittyKeyboardFilter strips two classes of escape sequence from the
// remote PTY's stdout before they reach the local terminal emulator
// (VS Code's xterm.js):
//
//   1. Kitty keyboard protocol — `CSI ? u` / `CSI > <n> u` / `CSI = <n> u`
//      and `CSI < u`. Rust TUIs (ratatui/crossterm) used by codex and
//      claude-cli probe + push kitty mode; xterm.js partially honours
//      the push and starts encoding keystrokes as `ESC[<code>;<mods>u`,
//      which round-trip onto the screen as `[27u` garbage because the
//      remote PTY's echo isn't synchronised with codex's raw-mode init.
//
//   2. OSC 10 / OSC 11 colour queries — `ESC ] 10 ; ? ST` and
//      `ESC ] 11 ; ? ST`. codex queries the emulator's default fg/bg
//      colour; xterm.js answers `ESC ] 10 ; rgb:cccc/cccc/cccc ST`.
//      That answer gets echoed back as visible `]10;rgb:.../...\\`
//      noise for the same reason.
//
// Filtering happens upstream of the emulator: if xterm.js never sees
// the trigger sequence, it never produces the troublesome response.
// codex falls through to the well-trodden legacy keyboard / no-colour
// path, which it handles fine.
//
// The filter is byte-level and stateful because escape sequences can
// straddle transport chunks.
type kittyKeyboardFilter struct {
	state int    // see comments below
	buf   []byte // accumulating an in-flight escape we may yet decide to drop
}

const (
	fStateNormal       = 0  // outside any escape
	fStateAfterESC     = 1  // saw 0x1b
	fStateAfterCSI     = 2  // saw "\x1b["
	fStateInKittyCSI   = 3  // saw "\x1b[" + one of ?<>=
	fStateAfterOSC     = 4  // saw "\x1b]"
	fStateInOSCNum     = 5  // saw "\x1b]" + digits (number not yet confirmed 10/11)
	fStateInOSCDrop    = 6  // confirmed OSC 10/11 — drop until ST
	fStateInOSCKeep    = 7  // confirmed other OSC — keep until ST
	fStateOSCEsc       = 8  // saw 0x1b inside a *dropped* OSC — next byte determines ST
	fStateOSCKeepEsc   = 9  // saw 0x1b inside a *kept* OSC — next byte determines ST
)

func newKittyKeyboardFilter() *kittyKeyboardFilter {
	return &kittyKeyboardFilter{buf: make([]byte, 0, 32)}
}

func (f *kittyKeyboardFilter) Filter(in []byte) []byte {
	if len(in) == 0 {
		return in
	}
	out := make([]byte, 0, len(in))
	for _, b := range in {
		switch f.state {
		case fStateNormal:
			if b == 0x1b {
				f.buf = append(f.buf[:0], b)
				f.state = fStateAfterESC
			} else {
				out = append(out, b)
			}

		case fStateAfterESC:
			f.buf = append(f.buf, b)
			if b == '[' {
				f.state = fStateAfterCSI
			} else if b == ']' {
				f.state = fStateAfterOSC
			} else {
				// Some other escape (e.g. "\x1bD" index, "\x1b7" save
				// cursor) — pass through unchanged.
				out = append(out, f.buf...)
				f.buf = f.buf[:0]
				f.state = fStateNormal
			}

		case fStateAfterCSI:
			if b == '?' || b == '>' || b == '<' || b == '=' {
				f.buf = append(f.buf, b)
				f.state = fStateInKittyCSI
			} else {
				// Not a kitty-introducer CSI; flush + this byte goes
				// through as a normal CSI start.
				out = append(out, f.buf...)
				out = append(out, b)
				f.buf = f.buf[:0]
				f.state = fStateNormal
			}

		case fStateInKittyCSI:
			if (b >= '0' && b <= '9') || b == ';' || b == ':' {
				f.buf = append(f.buf, b)
			} else if b == 'u' {
				// Kitty keyboard final byte. Drop the whole sequence.
				f.buf = f.buf[:0]
				f.state = fStateNormal
			} else {
				// Different final byte (e.g. 'h' set-mode private,
				// 'l' reset-mode private, 'n' DSR) — must pass
				// through, those are unrelated DEC private modes.
				out = append(out, f.buf...)
				out = append(out, b)
				f.buf = f.buf[:0]
				f.state = fStateNormal
			}

		case fStateAfterOSC:
			// Start of an OSC body. The first byte should be a digit
			// kicking off the command number.
			if b >= '0' && b <= '9' {
				f.buf = append(f.buf, b)
				f.state = fStateInOSCNum
			} else {
				// Malformed OSC (no number) — let it through as-is so
				// we never accidentally swallow something legitimate.
				out = append(out, f.buf...)
				out = append(out, b)
				f.buf = f.buf[:0]
				f.state = fStateNormal
			}

		case fStateInOSCNum:
			if b >= '0' && b <= '9' {
				f.buf = append(f.buf, b)
			} else if b == ';' {
				// Parse the number so far. We only drop 10 / 11.
				num := parseLeadingNumber(f.buf, 2) // skip ESC ]
				f.buf = append(f.buf, b)
				if num == 10 || num == 11 {
					f.state = fStateInOSCDrop
				} else {
					// Different OSC (8 hyperlinks, 52 clipboard, ...).
					// Flush what we've accumulated and keep streaming
					// the body through.
					out = append(out, f.buf...)
					f.buf = f.buf[:0]
					f.state = fStateInOSCKeep
				}
			} else {
				// Number not followed by ';' — abnormal. Flush.
				out = append(out, f.buf...)
				out = append(out, b)
				f.buf = f.buf[:0]
				f.state = fStateNormal
			}

		case fStateInOSCDrop:
			// Swallow until ST. ST is BEL (0x07) or ESC \ (0x1b 0x5c).
			if b == 0x07 {
				f.buf = f.buf[:0]
				f.state = fStateNormal
			} else if b == 0x1b {
				f.state = fStateOSCEsc
			}
			// else: keep dropping body bytes

		case fStateOSCEsc:
			if b == '\\' {
				// ESC \ terminator — drop the whole sequence.
				f.buf = f.buf[:0]
				f.state = fStateNormal
			} else {
				// Stray ESC inside the dropped OSC — keep dropping but
				// the new ESC could itself be the start of something
				// else after the OSC was implicitly cancelled. To stay
				// safe, treat this as the start of a fresh escape:
				// emit nothing for the OSC, but start a new ESC state.
				f.buf = append(f.buf[:0], 0x1b)
				if b == '[' {
					f.buf = append(f.buf, b)
					f.state = fStateAfterCSI
				} else if b == ']' {
					f.buf = append(f.buf, b)
					f.state = fStateAfterOSC
				} else {
					// Pass through "\x1b<b>".
					out = append(out, 0x1b, b)
					f.buf = f.buf[:0]
					f.state = fStateNormal
				}
			}

		case fStateInOSCKeep:
			// Forward body bytes through; close when we see ST.
			out = append(out, b)
			if b == 0x07 {
				f.buf = f.buf[:0]
				f.state = fStateNormal
			} else if b == 0x1b {
				// Don't emit the ESC yet — it might be ST (ESC \).
				// Walk it back: drop the just-appended ESC and wait.
				out = out[:len(out)-1]
				f.state = fStateOSCKeepEsc
			}

		case fStateOSCKeepEsc:
			if b == '\\' {
				// ST — write ESC \ and finish.
				out = append(out, 0x1b, '\\')
				f.buf = f.buf[:0]
				f.state = fStateNormal
			} else {
				// Not ST; emit ESC then re-process this byte as a new
				// stream-level byte.
				out = append(out, 0x1b)
				// Re-enter the loop conceptually — easiest way is to
				// treat current b as the start of normal handling.
				if b == 0x1b {
					f.buf = append(f.buf[:0], b)
					f.state = fStateAfterESC
				} else {
					out = append(out, b)
					f.state = fStateInOSCKeep
				}
			}
		}
	}
	return out
}

// parseLeadingNumber reads decimal digits starting at offset `off` of
// `b` and returns the integer value. Stops at the first non-digit.
func parseLeadingNumber(b []byte, off int) int {
	n := 0
	for i := off; i < len(b); i++ {
		c := b[i]
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}
