package syncthing

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrStaleMembership is returned by MembershipStore.ValidateGeneration
// when the caller-supplied generation is not the current one for that
// folder_id (and a current one exists). Wire-level this maps to
// migration §5.4's ReasonStaleMembershipGeneration error; the
// dispatch layer is expected to convert this typed error into the
// wire reason on the way out to the misbehaving peer.
var ErrStaleMembership = errors.New("syncthing: stale membership_generation")

// ErrUnknownFolder is returned by MembershipStore.ValidateGeneration
// when the folder_id has never had a membership allocated. Distinct
// from ErrStaleMembership and ErrNoCurrentMembership so the dispatch
// layer can route by severity: ErrUnknownFolder is unusual enough to
// warrant a loud log line (mis-routed peer / dev config drift).
var ErrUnknownFolder = errors.New("syncthing: no membership for folder_id")

// ErrNoCurrentMembership is returned by MembershipStore.ValidateGeneration
// when the folder_id HAS had a membership but the holder was Revoke'd
// (fail-closed cleanup). The generation counter is preserved under a
// tombstone for monotonic-counter purposes, but the membership is no
// longer active and ANY incoming generation is rejected — a zombie
// session pinging the server with its old gen must NOT be honoured.
//
// Distinguished from ErrUnknownFolder because "you got revoked" is a
// normal-operations event after takeover / license revoke, while
// "this folder never existed" is a config bug. Distinguished from
// ErrStaleMembership because the issue isn't "your gen is old" — it's
// "no gen is current, period".
var ErrNoCurrentMembership = errors.New("syncthing: folder has no current membership (revoked)")

// Membership is one entry in the MembershipStore: the current
// (folder_id → who-holds-the-write-token) binding.
//
// Generation is server-assigned and strictly monotonic per folder
// across the store's lifetime, INCLUDING across Revoke (lease plan
// §P0a). Server bumps it on each successful sync hello; nothing else
// (sync.com pty, exec, status-poll) touches it.
//
// Identity carries the {client_id, client_instance_id,
// client_syncthing_device_id, ...} tuple the current holder
// presented; Identity.MembershipGeneration mirrors Generation here
// for ergonomic comparison.
//
// GrantedAt is the wall-clock moment AllocateGeneration committed
// this membership.
type Membership struct {
	Generation uint64
	Identity   LeaseIdentity
	GrantedAt  time.Time
}

// membershipEntry is the internal per-folder state. The split between
// `active` and `generation` is the fix for the round-1 review
// Blocking: if we kept the full Membership in the map after Revoke
// and only zeroed the Identity, ValidateGeneration's old "is gen ==
// current?" check would still accept zombie pings carrying the
// pre-Revoke generation. Splitting lets Revoke preserve the
// monotonic-counter tombstone (so next AllocateGeneration continues
// from gen+1) WITHOUT keeping the holder considered active.
type membershipEntry struct {
	generation uint64     // strict-monotonic counter; advances only via AllocateGeneration
	active     bool       // true between Allocate and the next Revoke; false during tombstone window
	membership Membership // valid iff active; zero-valued under tombstone
}

// MembershipStore is the server-side authority over which Lease
// identity currently holds the write-token for each folder. Per
// lease plan §P0a:
//
//   - Generation is strictly monotonic per folder_id ACROSS the
//     store's entire lifetime, including across Revoke.
//   - AllocateGeneration is the ONLY way to advance the counter —
//     every successful sync hello calls it; everything else (status
//     pushes, heartbeats, etc.) just calls ValidateGeneration.
//   - Revoke transitions the entry to inactive but PRESERVES the
//     counter for the next allocation. A zombie session pinging
//     with its old (now-Revoke'd) generation is rejected via
//     ErrNoCurrentMembership.
//
// MembershipStore knows NOTHING about Lease tick loops or close
// callbacks — it's pure state. The Lease object holds its own
// pre-allocated generation in Identity.MembershipGeneration; the
// store provides a server-wide consistent view across all live
// Leases.
//
// Safe for concurrent use.
type MembershipStore struct {
	mu sync.Mutex

	// folders maps folder_id → internal entry. An entry with
	// active=false is a tombstone preserving the generation counter
	// after Revoke. Absence means the folder was never allocated.
	folders map[string]membershipEntry

	now func() time.Time // overridable for tests
}

// NewMembershipStore returns an empty store with time.Now as the
// timestamp source.
func NewMembershipStore() *MembershipStore {
	return &MembershipStore{
		folders: map[string]membershipEntry{},
		now:     time.Now,
	}
}

// SetNow overrides the wall-clock source. Used by tests for
// deterministic GrantedAt timestamps.
func (s *MembershipStore) SetNow(fn func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fn == nil {
		fn = time.Now
	}
	s.now = fn
}

// AllocateGeneration bumps folder_id's generation by 1 and records
// the supplied identity as the new (active) holder. Returns the
// freshly-allocated Membership; the caller threads its Generation
// back into the Lease being constructed (NewLease's identity
// argument already carries it).
//
// The supplied identity's MembershipGeneration AND FolderID fields
// are REWRITTEN to match the freshly-allocated values in the
// returned copy. This removes the foot-gun where callers forget to
// stamp them back into the identity before constructing the Lease.
//
// AllocateGeneration is the ONLY mutation primitive that advances
// the counter. Even after a Revoke, the next AllocateGeneration
// produces prev.generation + 1 — strict monotonic guarantee.
func (s *MembershipStore) AllocateGeneration(folderID string, identity LeaseIdentity) (Membership, error) {
	if folderID == "" {
		return Membership{}, fmt.Errorf("syncthing: AllocateGeneration requires non-empty folder_id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.folders[folderID] // zero-value if not present; that's fine, generation==0
	nextGen := prev.generation + 1
	m := Membership{
		Generation: nextGen,
		Identity:   identity,
		GrantedAt:  s.now(),
	}
	m.Identity.FolderID = folderID
	m.Identity.MembershipGeneration = nextGen
	s.folders[folderID] = membershipEntry{
		generation: nextGen,
		active:     true,
		membership: m,
	}
	return m, nil
}

// Current returns the current Membership for folder_id and true iff
// the folder has an active holder. Returns zero-value Membership and
// false if:
//   - the folder was never allocated, OR
//   - the folder was Revoke'd and not re-allocated (tombstone state)
//
// Callers who need to distinguish "never existed" from "was revoked"
// use ValidateGeneration, which returns different typed errors.
func (s *MembershipStore) Current(folderID string) (Membership, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.folders[folderID]
	if !ok || !e.active {
		return Membership{}, false
	}
	return e.membership, true
}

// ValidateGeneration is the receive-side check for any control
// message that carries a (folder_id, membership_generation) tuple.
//
// Verdicts (mutually exclusive, checked in order):
//
//  1. Returns ErrUnknownFolder iff folder_id has NO entry (never
//     allocated). Distinct so the dispatch layer can log loudly —
//     this shouldn't happen in normal operation.
//
//  2. Returns ErrNoCurrentMembership iff folder_id has an entry but
//     it's a Revoke'd tombstone. Any incoming generation is
//     rejected — a zombie session must not be honoured. This is the
//     fail-closed guarantee around Revoke.
//
//  3. Returns ErrStaleMembership (wrapped with current/got detail)
//     iff folder_id has an active entry but gen != current. Covers
//     both stale (gen < current) and future-bogus (gen > current,
//     i.e. protocol violation since clients can't allocate).
//
//  4. Returns nil iff folder_id has an active entry and gen ==
//     current.
func (s *MembershipStore) ValidateGeneration(folderID string, gen uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.folders[folderID]
	if !ok {
		return fmt.Errorf("%w: folder_id=%q", ErrUnknownFolder, folderID)
	}
	if !e.active {
		return fmt.Errorf("%w: folder_id=%q (last gen %d revoked)", ErrNoCurrentMembership, folderID, e.generation)
	}
	if gen != e.generation {
		return fmt.Errorf("%w: folder_id=%q got=%d current=%d", ErrStaleMembership, folderID, gen, e.generation)
	}
	return nil
}

// Revoke transitions folder_id's entry to inactive (tombstone),
// preserving the generation counter for the next AllocateGeneration.
//
// UNCONDITIONAL: does not check who is currently active. Safe to use
// for administrative/operator force-revoke paths where the caller
// explicitly intends to kick the current holder regardless of which
// generation it is. UNSAFE for per-session close hooks — a stale
// session's onClose would tombstone the membership held by whoever
// has since taken over. Per-session close paths MUST use
// RevokeIfCurrent instead.
//
// Returns true iff an active entry was just transitioned to inactive
// (i.e. there was something to revoke). Returns false if the folder
// has no entry or already has an inactive (tombstone) entry.
func (s *MembershipStore) Revoke(folderID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, existed := s.folders[folderID]
	if !existed || !e.active {
		return false
	}
	s.folders[folderID] = membershipEntry{
		generation: e.generation, // preserved — strict-monotonic across Revoke
		active:     false,
		// membership zero-valued under tombstone
	}
	return true
}

// RevokeIfCurrent transitions folder_id's entry to inactive ONLY if
// the current generation matches the supplied gen. The safe primitive
// for per-session close hooks (Lease.onClose). The supplied gen is
// the generation the lease holds; if a takeover has bumped the
// counter in the meantime, the lease is stale and MUST NOT touch the
// new holder's membership.
//
// Returns true iff the revoke applied. Returns false (no-op) when:
//   - folder has no entry, OR
//   - folder is already tombstoned, OR
//   - folder has an active entry but at a different generation
//     (the canonical "stale lease" case — caller should also skip any
//     downstream cleanup such as UpdateDesiredFolder, since the
//     current holder owns the desired state for that folder)
//
// The tombstone preserves the current generation counter for strict
// monotonic guarantee across the store's lifetime — matches Revoke
// semantics.
func (s *MembershipStore) RevokeIfCurrent(folderID string, gen uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, existed := s.folders[folderID]
	if !existed || !e.active {
		return false
	}
	if e.generation != gen {
		return false
	}
	s.folders[folderID] = membershipEntry{
		generation: e.generation,
		active:     false,
	}
	return true
}
