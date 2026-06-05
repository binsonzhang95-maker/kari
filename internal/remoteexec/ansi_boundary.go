package remoteexec

// AnsiSplitter finds a "safe" split point in a stream of PTY output
// so the server never frames a chunk that ends inside an unfinished
// ANSI escape sequence. Without this, a 32KB read that happens to
// land mid-`\x1b[H\x1b[2J` makes the receiving xterm.js eat the
// prefix and render the suffix as literal characters — which is
// exactly the "字行错位 / 残留" symptom users see in vim, htop, and
// claude's interactive prompt.
//
// The splitter tracks a small state machine across calls so partial
// sequences spanning two reads still get coalesced. State lives on
// the caller (one *AnsiSplitter per PTY stream).
type AnsiSplitter struct {
	state ansiState
	// pending carries the unflushed tail from the prior call.
	// Capped by maxPending below; if a single sequence exceeds the
	// cap we give up and flush anyway (better a one-frame visual
	// glitch than a hung terminal).
	pending []byte
}

type ansiState int

const (
	ansiIdle      ansiState = iota
	ansiAfterESC            // saw 0x1b, awaiting introducer / single-byte-final
	ansiCSI                 // ESC [ ... <final 0x40-0x7E>
	ansiString              // ESC ] | P | ^ | _   (OSC / DCS / PM / APC) — string-terminator delimited
	ansiStringESC           // saw 0x1b inside a string sequence; ST is ESC \ , but we close the seq either way
)

// maxPending is the buffering cap. A single "real" ANSI sequence is
// at most a few hundred bytes (OSC 52 clipboard payloads can be ~kB).
// 32 KB gives huge headroom; beyond that it's almost certainly a bug
// (binary garbage with stray ESC bytes) and forcing a flush prevents
// runaway memory.
const ansiSplitterMaxPending = 32 * 1024

// Feed appends src to the splitter's pending buffer and returns the
// largest prefix that ends outside any incomplete escape sequence.
// The caller sends the returned slice and discards it; the splitter
// keeps the unflushable tail for next time. Returned slice references
// internal storage and is invalidated by the next Feed call — copy
// before stashing.
func (s *AnsiSplitter) Feed(src []byte) []byte {
	if len(src) == 0 {
		return nil
	}
	s.pending = append(s.pending, src...)
	cut := s.scanCut()
	if cut == 0 {
		// Nothing safely flushable; check the runaway cap.
		if len(s.pending) > ansiSplitterMaxPending {
			out := s.pending
			s.pending = nil
			s.state = ansiIdle // give up tracking; caller likely got binary garbage
			return out
		}
		return nil
	}
	out := s.pending[:cut]
	// Move the unflushed tail to the front. Reusing the underlying
	// array would alias `out`, so allocate fresh to keep the contract
	// "out is valid until next Feed".
	tail := append([]byte(nil), s.pending[cut:]...)
	s.pending = tail
	return out
}

// Flush returns whatever's still pending and resets state. Call at
// stream shutdown so trailing content (including a partial sequence
// that never completed) reaches the peer.
func (s *AnsiSplitter) Flush() []byte {
	if len(s.pending) == 0 {
		return nil
	}
	out := s.pending
	s.pending = nil
	s.state = ansiIdle
	return out
}

// scanCut walks pending forward from the current state and returns
// the largest prefix length that ends in ansiIdle. Updates state.
func (s *AnsiSplitter) scanCut() int {
	cut := 0
	st := s.state
	for i, b := range s.pending {
		switch st {
		case ansiIdle:
			if b == 0x1b {
				st = ansiAfterESC
			} else {
				cut = i + 1
			}
		case ansiAfterESC:
			switch b {
			case '[':
				st = ansiCSI
			case ']', 'P', '^', '_':
				st = ansiString
			default:
				// Any other byte completes a short ESC sequence
				// (single-char like ESC D, or charset designator like
				// ESC ( B — we accept being slightly conservative on
				// 3-byte designators by treating them as 2-byte; the
				// next byte ends up in idle and gets flushed normally).
				st = ansiIdle
				cut = i + 1
			}
		case ansiCSI:
			// CSI parameters are 0x30-0x3F, intermediates 0x20-0x2F,
			// final byte is 0x40-0x7E.
			if b >= 0x40 && b <= 0x7e {
				st = ansiIdle
				cut = i + 1
			}
		case ansiString:
			// OSC accepts BEL (0x07) as terminator; all four also
			// accept ST (ESC \). We close on either.
			if b == 0x07 {
				st = ansiIdle
				cut = i + 1
			} else if b == 0x1b {
				st = ansiStringESC
			}
		case ansiStringESC:
			// We just saw ESC inside a string sequence. Whether or
			// not the next byte is `\` (proper ST) we close the
			// sequence here — being slightly permissive about ST
			// shape is safer than waiting forever on a malformed
			// stream.
			st = ansiIdle
			cut = i + 1
		}
	}
	s.state = st
	return cut
}
