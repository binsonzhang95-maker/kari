package syncthing

import (
	"context"
	"sync"
	"time"
)

// LeaseState is the current point in the lease's state machine.
//
//	LeaseActive ↔ LeaseGrace    (the "gate is open" half)
//	─────────── terminal ───────────
//	LeasePaused                  (the "gate is closed" half)
//
// Active ↔ Grace flips are cheap and reversible: any successful
// control-channel message Touches the lease back to Active; a stream
// error MarkStreamErrors it to Grace. Paused is terminal — once a
// lease is closed (timeout / explicit revoke / explicit
// session_replaced), it stays closed and the next session must
// construct a fresh Lease with a new membership_generation.
//
// This matches lease plan §3.1: "Paused 状态不接受 Touch 复活" — a
// re-attached session is an entirely new Lease object, not the same
// one walking backwards out of Paused.
type LeaseState int

const (
	// LeaseActive is the steady state — the gate is open, peers may
	// exchange data, the 1s tick has not seen elapsed > 105s.
	LeaseActive LeaseState = iota
	// LeaseGrace marks a transient stream-error window. Functionally
	// the gate is STILL open (peers can keep going), but the tick
	// loop is now counting down toward the 105s absolute trigger
	// against a forward-dated lastAuthorizedAt. A successful message
	// in this window Touches back to Active.
	LeaseGrace
	// LeasePaused is terminal. The gate is closed, the close hook
	// has fired (or will, depending on race with state read), and
	// no Touch / MarkStreamError will resurrect this Lease. Callers
	// construct a new Lease for the next session.
	LeasePaused
)

// String returns the lowercase state name. Stable; used for status /
// log emissions.
func (s LeaseState) String() string {
	switch s {
	case LeaseActive:
		return "active"
	case LeaseGrace:
		return "grace"
	case LeasePaused:
		return "paused"
	default:
		return "unknown"
	}
}

// LeaseIdentity is the {client_id, device_id, instance_id,
// membership_generation} tuple a Lease carries through its lifetime.
// Migration §2.5 / §4.4 + lease plan §P0a require the receiver of a
// session_replaced envelope to verify `to_membership_generation >
// local_membership_generation && folder_id matches` before
// honouring the kick — Lease.Identity() exposes the local view of
// that tuple so the dispatch layer (PR1.2c-followup, in cmd/server +
// internal/syncd) can do the comparison.
type LeaseIdentity struct {
	WorkspaceID             string
	WorkspaceName           string
	ClientID                string
	ClientInstanceID        string
	ClientSyncthingDeviceID string
	FolderID                string
	MembershipGeneration    uint64
}

// LeaseCloseReason names why a Lease transitioned to LeasePaused.
// Stable strings; surfaced via the close hook + status reporting.
const (
	LeaseCloseTimeout         = "lease_timeout"
	LeaseCloseRevoked         = "revoked"
	LeaseCloseSessionReplaced = "session_replaced"
	LeaseCloseSessionEnd      = "session_end"
	// LeaseCloseManual is reserved for tests / mgmt API.
	LeaseCloseManual = "manual"
)

// LeaseOptions configures non-default timings for a Lease. Zero
// fields mean "use the production default" — tests override the
// timeout / grace / clock / tick interval to exercise the state
// machine deterministically.
type LeaseOptions struct {
	// Timeout is the absolute interval between lastAuthorizedAt and
	// the next tick at which the loop transitions to LeasePaused.
	// Default: 105s (lease plan §3.2).
	Timeout time.Duration
	// GraceOffset is what MarkStreamError subtracts from now() when
	// shifting lastAuthorizedAt. With default Timeout=105s and
	// default GraceOffset=45s, a stream error fires the timeout
	// trigger exactly 60s later. Default: 45s.
	GraceOffset time.Duration
	// TickInterval is the cadence of the absolute-timeout check loop
	// (Run). Default: 1s.
	TickInterval time.Duration
	// Now overrides time.Now. Used by tests to inject deterministic
	// time advancement without sleeping.
	Now func() time.Time
}

// Lease is one Syncthing-backend session's authorization gate. State
// transitions are documented on LeaseState. Methods are safe for
// concurrent use.
//
// Constructing a Lease does NOT start the tick loop — callers invoke
// Run(ctx) in a goroutine if they want the timeout to fire on its
// own. The 1s tick is the only thing that can elapse a Lease from
// Active/Grace into Paused on its own; explicit ForceClose works
// regardless of whether Run is active.
type Lease struct {
	mu sync.Mutex

	identity         LeaseIdentity
	state            LeaseState
	lastAuthorizedAt time.Time

	// onClose fires exactly once on the transition to LeasePaused.
	// Called OUTSIDE the lease mutex so handlers may re-enter
	// (e.g. call Identity / State) without deadlocking. Handlers
	// MUST NOT call ForceClose on the same lease — it's a no-op
	// because state is already Paused, but the closeOnce guard
	// makes that explicit.
	//
	// CONTRACT — non-blocking required:
	//
	// The hook executes INSIDE ForceClose's caller goroutine; that
	// caller (e.g. cmd/server's supervise() via
	// notifyRevokeAndForceClose) is waiting for the hook to return
	// before it can fire the bounded ReasonRevoked notification and
	// cancel() the gRPC stream. A hook that blocks on REST IO,
	// Reconciler.Reconcile (which serializes on runMu + retries with
	// up to 15s of backoff), or any external mutex held for more
	// than tens of microseconds WILL delay the client-side fail-
	// closed signal by that same amount.
	//
	// Recommended pattern for a server-side fail-closed hook:
	//
	//	onClose := func(reason string) {
	//	    membership.Revoke(folderID)               // mutex map mutate — fast
	//	    _ = reconciler.SetDesired(<paused>)       // mutex map mutate — fast
	//	    reconciler.RequestReconcile()             // non-blocking signal
	//	}
	//
	// The actual Reconciler.Reconcile() and its PutFolder REST call
	// happen asynchronously on the tick loop owner's goroutine,
	// which selects on Reconciler.RequestChan(). This decouples
	// "client-side fail-closed UX latency" from "server-side
	// data-plane cleanup latency."
	onClose func(reason string)

	// Configurable timings — see LeaseOptions.
	timeout      time.Duration
	graceOffset  time.Duration
	tickInterval time.Duration
	now          func() time.Time

	// closeOnce ensures onClose fires exactly once even if multiple
	// goroutines race ForceClose / Run / explicit message dispatch.
	closeOnce sync.Once
}

// Production defaults — exported so callers can read them when
// constructing a Lease without binding to LeaseOptions zero-value
// semantics.
const (
	DefaultLeaseTimeout      = 105 * time.Second
	DefaultLeaseGraceOffset  = 45 * time.Second
	DefaultLeaseTickInterval = 1 * time.Second
)

// NewLease constructs a Lease in LeaseActive state with
// lastAuthorizedAt = now. The onClose callback fires once when the
// lease transitions to LeasePaused; pass nil if you don't need the
// notification.
//
// Identity should be fully populated by the caller — Lease does NOT
// allocate or mutate membership_generation; that lives in
// MembershipStore.AllocateGeneration. This split lets a Lease be
// constructed with a pre-allocated generation that's stable for the
// lease's lifetime.
func NewLease(identity LeaseIdentity, onClose func(reason string), opts LeaseOptions) *Lease {
	l := &Lease{
		identity: identity,
		state:    LeaseActive,
		onClose:  onClose,

		timeout:      opts.Timeout,
		graceOffset:  opts.GraceOffset,
		tickInterval: opts.TickInterval,
		now:          opts.Now,
	}
	if l.timeout <= 0 {
		l.timeout = DefaultLeaseTimeout
	}
	if l.graceOffset <= 0 {
		l.graceOffset = DefaultLeaseGraceOffset
	}
	if l.tickInterval <= 0 {
		l.tickInterval = DefaultLeaseTickInterval
	}
	if l.now == nil {
		l.now = time.Now
	}
	l.lastAuthorizedAt = l.now()
	return l
}

// Identity returns a copy of the lease's identity tuple. Safe for
// concurrent use; Identity is immutable for a given Lease (the
// membership_generation that distinguishes successive sessions is
// embedded in the identity, so a new generation = a new Lease).
func (l *Lease) Identity() LeaseIdentity {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.identity
}

// State returns the current state. Snapshot.
func (l *Lease) State() LeaseState {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.state
}

// LastAuthorizedAt returns the timestamp the lease will measure its
// 105s timeout against on the next tick. Exposed for diagnostics /
// status reporting.
func (l *Lease) LastAuthorizedAt() time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastAuthorizedAt
}

// Touch records a successful control-channel observation. If the
// lease is Active or Grace, it transitions to Active and bumps
// lastAuthorizedAt = now. Touch on a Paused lease is a no-op (the
// gate stays closed — the session is gone, period).
func (l *Lease) Touch() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == LeasePaused {
		return
	}
	l.state = LeaseActive
	l.lastAuthorizedAt = l.now()
}

// MarkStreamError moves an Active/Grace lease to Grace, fast-
// forwarding lastAuthorizedAt to (now - graceOffset) so the next
// tick that observes elapsed >= timeout fires exactly graceOffset
// short of "the wall clock now plus timeout". With the production
// defaults (timeout=105s, graceOffset=45s) this gives 60s of grace.
//
// A subsequent Touch within the grace window resets to Active.
// MarkStreamError on a Paused lease is a no-op.
func (l *Lease) MarkStreamError() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == LeasePaused {
		return
	}
	l.state = LeaseGrace
	l.lastAuthorizedAt = l.now().Add(-l.graceOffset)
}

// ForceClose transitions the lease to LeasePaused unconditionally and
// fires the onClose hook exactly once. Safe to call from any state;
// on a Paused lease it's a no-op.
//
// reason should be one of the LeaseClose* string constants so log /
// status routing is stable. Handlers can compare with == (no parsing).
func (l *Lease) ForceClose(reason string) {
	l.mu.Lock()
	if l.state == LeasePaused {
		l.mu.Unlock()
		return
	}
	l.state = LeasePaused
	hook := l.onClose
	l.mu.Unlock()

	l.closeOnce.Do(func() {
		if hook != nil {
			hook(reason)
		}
	})
}

// Run drives the 1s timeout tick until ctx is cancelled OR the lease
// enters LeasePaused. Safe to call once per Lease; calling Run on a
// Paused lease returns immediately.
//
// Returns nil on ctx cancel + state-transitioned exit; never returns
// a non-nil error (state changes flow through onClose, not the Run
// return value).
func (l *Lease) Run(ctx context.Context) {
	if l.State() == LeasePaused {
		return
	}
	t := time.NewTicker(l.tickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if l.checkTimeout() {
				return
			}
		}
	}
}

// checkTimeout is one iteration of the Run loop's absolute-timeout
// check. Returns true if the lease just transitioned to Paused (the
// Run loop should exit). Exposed unexported so tests can drive the
// state machine without a real ticker.
func (l *Lease) checkTimeout() bool {
	l.mu.Lock()
	if l.state == LeasePaused {
		l.mu.Unlock()
		return true
	}
	elapsed := l.now().Sub(l.lastAuthorizedAt)
	exceeded := elapsed >= l.timeout
	l.mu.Unlock()
	if !exceeded {
		return false
	}
	l.ForceClose(LeaseCloseTimeout)
	return true
}
