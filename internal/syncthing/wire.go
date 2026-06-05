package syncthing

import (
	"errors"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// WireReasonForError maps the typed errors emitted by this package
// (MembershipStore.ValidateGeneration in particular) into the
// transport.Reason* wire string the dispatch layer should set on the
// outgoing MessageError envelope. Returns "" if err is nil or doesn't
// match any known typed error; caller decides whether to surface a
// generic error string in that case or drop the message.
//
// The mapping is intentionally explicit per-error AND
// non-collapsing — ReasonNoCurrentMembership and
// ReasonStaleMembershipGeneration carry distinct semantics (see
// lease plan §P0a). A future refactor that "simplifies" them to a
// single wire reason would silently change Client-visible UX and
// break the §5.4 dispatch contract; the TestWireReasonsDontCollapse
// guard in wire_test.go pins this.
//
//	ErrNoCurrentMembership → transport.ReasonNoCurrentMembership
//	ErrStaleMembership     → transport.ReasonStaleMembershipGeneration
//	ErrUnknownFolder       → ""  (caller logs as config bug; no stable
//	                              wire reason for "never existed")
//	any other err          → ""
func WireReasonForError(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrNoCurrentMembership):
		return transport.ReasonNoCurrentMembership
	case errors.Is(err, ErrStaleMembership):
		return transport.ReasonStaleMembershipGeneration
	default:
		// Includes ErrUnknownFolder: deliberately no wire reason.
		// "Folder never existed" is a server-side configuration bug
		// or a peer that's genuinely misrouted; surfacing a stable
		// wire reason for it would invite clients to handle it as a
		// normal-operation event, which it isn't.
		return ""
	}
}
