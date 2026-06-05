package syncthing

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Desired is the reconciler's view of what Syncthing config MUST look
// like, on each tick. It is the single source of truth the reconciler
// pushes Syncthing back toward whenever they diverge.
//
// Folders lists every Kari-managed folder. Any folder Syncthing config
// has but Desired does not is "unknown" — quarantined (paused) but
// never auto-deleted (migration §4.5 step 6).
//
// Options is the global Syncthing options block. v1 expects the
// fail-closed-safe set (all four flags = false); the reconciler will
// PutOptions back to whatever Desired.Options says on every drift.
type Desired struct {
	Folders []DesiredFolder
	Options ConfigOptions
}

// DesiredFolder is the spec for a single managed folder. The lease
// state machine (PR1.2c) drives transitions in DesiredFolder.Paused
// and .Devices as membership changes; the reconciler then pushes
// Syncthing config to match.
type DesiredFolder struct {
	ID      string
	Path    string
	Type    string // "" | sendonly | receiveonly | sendreceive — see FolderType*
	Label   string // Kari-owned per migration §3.7 D7; preserved across MarkDesiredCleanup
	Paused  bool
	Devices []Device
}

// DriftEvent is emitted via SetOnDrift whenever the reconciler
// observes Syncthing config deviating from Desired. One event per
// drift cause per tick (a folder can emit multiple if it drifts in
// multiple dimensions).
//
// Kind is a stable short string for log/alert routing. Detail is
// human-readable supplementary context.
type DriftEvent struct {
	FolderID string // empty for global options drift
	Kind     string
	Detail   string
}

// Drift kinds. Kept as exported constants so callers (alerting,
// dashboards) can match without scraping log strings.
const (
	DriftKindOptions        = "options_drift"
	DriftKindUnknownFolder  = "unknown_folder"
	DriftKindMissingFolder  = "missing_folder"
	DriftKindStrayDevices   = "stray_devices"
	DriftKindMissingDevices = "missing_devices"
	DriftKindPausedWantTrue = "paused_wants_true"  // actual.Paused=false, desired.Paused=true (cleanup direction)
	DriftKindPausedWantFalse = "paused_wants_false" // actual.Paused=true, desired.Paused=false (forward direction)
	DriftKindType           = "type_mismatch"
	DriftKindPath           = "path_mismatch"
)

// ErrBlocked is returned by OperatorRetry when called on a reconciler
// that isn't actually blocked, and is also wrapped by reconcile errors
// after the reconciler enters terminal blocked state. Use
// errors.Is to detect.
var ErrBlocked = errors.New("syncthing: reconciler is blocked")

// Reconciler enforces a Desired config on a Client (real REST or
// FakeClient) via GetConfig → diff → PutFolder / PutOptions cycles.
// It is the cold-safety + reconciler-authority kernel:
//
//   - Global options drift is repaired unconditionally on every tick.
//   - Folder drift is categorised as "cleanup direction" (pause /
//     remove stray device — safer state) or "forward direction"
//     (unpause / add device / create folder — wider attack surface).
//   - Cleanup writes proceed even when the reconciler is in blocked
//     state. Forward writes are gated by: !blocked AND no repair
//     happened earlier in the same tick (migration §4.5 step 5
//     "同 tick 不 unpause").
//   - PutFolder / PutOptions errors retry with exponential backoff
//     (default 0/1s/2s/4s/8s = 5 attempts); after the final failure
//     the reconciler enters terminal blocked state (§4.5 step 7
//     Option A: do NOT exit — operator triggers retry via
//     OperatorRetry to clear the latch).
//
// Concurrency:
//   - Reconcile and OperatorRetry are MUTUALLY serialized via runMu.
//     A concurrent caller queues; an in-flight reconcile is not
//     interrupted. This prevents a semantic race where goroutine A
//     has snapshotted blocked=false at the top of Reconcile and is
//     mid-tick when goroutine B (another Reconcile / OperatorRetry)
//     transitions the reconciler to blocked — without serialization
//     A would happily continue issuing forward writes against the
//     now-closed latch.
//   - State accessors (SetDesired, Desired, IsBlocked, BlockReason,
//     ColdSafetyFailed, the SetOn* / SetBackoffs setters) hold only
//     the lighter mu, so callers and dashboards can read status
//     while a tick is in flight.
//   - The OnDrift / OnBlock hooks fire OUTSIDE both mutexes. Handlers
//     may read the reconciler's state but MUST NOT call Reconcile /
//     OperatorRetry on the same reconciler from the handler — that
//     would deadlock on runMu.
type Reconciler struct {
	// runMu serializes Reconcile + OperatorRetry against each other.
	// Held for the full duration of one tick (including all client
	// round-trips). NOT held while OnDrift / OnBlock handlers run.
	runMu sync.Mutex

	// mu protects everything below for short critical sections.
	mu sync.Mutex

	client  Client
	desired Desired

	blocked          bool
	blockReason      string
	coldSafetyFailed int // monotonic counter for /v1/status

	backoffs []time.Duration

	onDrift func(DriftEvent)
	onBlock func(reason string)

	// requestCh carries non-blocking "please run a reconcile tick
	// soon" signals from hooks (Lease.onClose, MembershipStore
	// lifecycle events) to the tick loop owner. Size 1 so multiple
	// back-to-back RequestReconcile calls coalesce. Drained by the
	// tick loop owner selecting on RequestChan().
	requestCh chan struct{}

	// Last-tick error visibility surface, populated only by Run's
	// inner runOneTick (manual Reconcile calls by tests / operator
	// retries do NOT touch these — they have their own error
	// returns). Read via LastReconcileError / LastReconcileErrorAt /
	// ReconcileErrorCount; intended for mgmt status surfaces so a
	// persistent GetConfig 5xx (or any tick error) is observable
	// even though Run silently absorbs to keep the loop alive.
	lastTickErr   error
	lastTickErrAt time.Time
	tickErrCount  uint64
}

// defaultBackoffs gives the per-attempt delays for the cold-safety
// retry loop. 5 entries = 5 attempts. First entry is 0 so the initial
// attempt runs immediately; subsequent entries are the inter-attempt
// sleeps (migration §4.5 step 7: 1s, 2s, 4s, 8s).
var defaultBackoffs = []time.Duration{
	0,
	1 * time.Second,
	2 * time.Second,
	4 * time.Second,
	8 * time.Second,
}

// NewReconciler constructs a Reconciler with no Desired state and
// default backoffs. Caller MUST call SetDesired before the first
// Reconcile; otherwise every actual folder gets treated as "unknown"
// and quarantined.
func NewReconciler(client Client) *Reconciler {
	return &Reconciler{
		client:    client,
		requestCh: make(chan struct{}, 1),
	}
}

// SetDesired replaces the full Desired state. The input is deep-
// copied (folder slice + each folder's Devices slice) so the caller
// can mutate or reuse its own value freely after this returns without
// racing the reconciler.
//
// Returns an error (and leaves prior state untouched) if the input
// violates basic invariants:
//   - any folder has an empty ID
//   - two folders share an ID
//
// Per-folder field validity (Type ∈ {sendonly, ...}, devices etc.)
// is still checked at PutFolder time via Folder.Validate; SetDesired
// only catches the multi-folder structural errors.
func (r *Reconciler) SetDesired(d Desired) error {
	cloned, err := cloneDesired(d)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.desired = cloned
	return nil
}

// Desired returns the current desired state as a deep copy — caller
// may mutate the returned slices without affecting the reconciler.
func (r *Reconciler) Desired() Desired {
	r.mu.Lock()
	d := r.desired
	r.mu.Unlock()
	// cloneDesired's only error path is invalid input; the stored
	// state was validated at SetDesired time, so this can't fail.
	out, _ := cloneDesired(d)
	return out
}

// cloneDesired deep-copies a Desired and rejects structural errors
// (empty / duplicate folder IDs). Pure function; safe to call without
// the reconciler mutex.
func cloneDesired(d Desired) (Desired, error) {
	out := Desired{Options: d.Options}
	if len(d.Folders) == 0 {
		return out, nil
	}
	out.Folders = make([]DesiredFolder, 0, len(d.Folders))
	seen := make(map[string]struct{}, len(d.Folders))
	for i, f := range d.Folders {
		if f.ID == "" {
			return Desired{}, fmt.Errorf("syncthing: Desired.Folders[%d].ID is empty", i)
		}
		if _, dup := seen[f.ID]; dup {
			return Desired{}, fmt.Errorf("syncthing: Desired contains duplicate folder ID %q", f.ID)
		}
		seen[f.ID] = struct{}{}
		cf := f
		if len(f.Devices) > 0 {
			cf.Devices = append([]Device(nil), f.Devices...)
		} else {
			cf.Devices = nil
		}
		out.Folders = append(out.Folders, cf)
	}
	return out, nil
}

// SetBackoffs overrides the default cold-safety retry schedule.
// Tests pass a slice of zeros to avoid real sleeps. Length determines
// the max attempts: len(backoffs) attempts in total.
func (r *Reconciler) SetBackoffs(b []time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.backoffs = append([]time.Duration(nil), b...)
}

// SetOnDrift installs (or removes when nil) a drift-event handler.
// Fired from within Reconcile but outside the reconciler's mutex.
func (r *Reconciler) SetOnDrift(fn func(DriftEvent)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onDrift = fn
}

// SetOnBlock installs (or removes when nil) a handler invoked
// exactly once each time the reconciler transitions from non-blocked
// to blocked. Not called for repeated PutFolder failures while
// already blocked.
func (r *Reconciler) SetOnBlock(fn func(reason string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onBlock = fn
}

// IsBlocked reports whether the reconciler is in terminal blocked
// state (cold-safety retries exhausted, awaiting operator retry).
func (r *Reconciler) IsBlocked() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.blocked
}

// BlockReason returns the human-readable reason the reconciler is
// blocked, or "" if not blocked.
func (r *Reconciler) BlockReason() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.blockReason
}

// ColdSafetyFailed returns the count of times the reconciler has
// transitioned into blocked state (migration §4.5 step 7
// `kari_syncthing_cold_safety_failed=N`). Reset to zero only via a
// successful OperatorRetry.
func (r *Reconciler) ColdSafetyFailed() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.coldSafetyFailed
}

// RequestReconcile is the non-blocking "please run a reconcile tick
// soon" signal used by hooks that MUST NOT block on REST IO —
// principally Lease.onClose, where the gRPC supervise() goroutine
// is waiting for the hook to return so it can fire the bounded
// ReasonRevoked notify + cancel(). Hooks call this AFTER any fast
// SetDesired update; the tick loop owner (typically a cmd/server-
// side goroutine selecting on RequestChan + a periodic Ticker)
// picks up the signal and calls Reconcile on its own.
//
// Idempotent: multiple back-to-back calls coalesce to a single
// pending signal (the size-1 buffered channel drops overflow).
//
// If no tick loop owner is wired yet (e.g. pre-§8 step 1, when
// cmd/server has not yet spawned the reconciler goroutine), the
// signal is dropped on the floor — but the underlying SetDesired
// change is still committed and the next caller-initiated
// Reconcile() will observe it. There is NO state-corruption risk
// from a dropped signal; the worst case is delayed convergence
// until the next manual Reconcile or the next live tick.
func (r *Reconciler) RequestReconcile() {
	select {
	case r.requestCh <- struct{}{}:
	default:
		// Already pending — coalesce. The next RequestChan reader
		// will see exactly one signal regardless of how many
		// callers raced here.
	}
}

// RequestChan returns the buffered channel tick loop owners select
// on alongside their periodic Ticker. Reads drain the pending
// signal; treat it as edge-triggered (one read per RequestReconcile
// burst, not per call).
//
// The returned channel is owned by the Reconciler; callers must
// not close it.
func (r *Reconciler) RequestChan() <-chan struct{} {
	return r.requestCh
}

// Run drives Reconcile in a loop, firing on each RequestChan signal
// AND on each tick of an optional periodic ticker. Returns when ctx
// is cancelled. This is the production tick loop owner for the
// RequestReconcile contract: hooks (Lease.onClose et al.) signal
// non-blockingly via RequestReconcile, and Run is the goroutine that
// turns those signals into real Reconcile calls.
//
// tickInterval > 0 establishes a periodic-tick safety net so
// desired-state convergence happens even if no signal arrives —
// matters for the drift-detection contract in migration §4.5 (the
// reconciler MUST notice rogue config edits within at most one tick
// even if nothing wakes it via RequestReconcile). tickInterval <= 0
// disables the periodic ticker; Run becomes purely signal-driven —
// only acceptable for tests that drive RequestReconcile manually.
//
// Per-tick Reconcile errors are intentionally NOT logged or returned
// from Run. The structured signal surface (OnDrift / OnBlock hooks,
// IsBlocked / ColdSafetyFailed status) already conveys the
// operationally important state. A transient GetConfig hiccup gets
// retried on the next tick or signal; persistent PutFolder failure
// escalates to blocked state via the inner retry loop, which fires
// OnBlock exactly once. Run silently absorbs per-tick errors to keep
// the loop alive.
//
// Concurrency: safe against itself only in the sense that two
// concurrent Run goroutines would each call Reconcile, which
// serializes on runMu — they'd both run but waste cycles. Callers
// should run a single Run per Reconciler at a time.
//
// Lifecycle: shutdown is via ctx cancel. Run does NOT call cancel()
// on any in-flight Reconcile — Reconcile uses the ctx it's passed,
// so cancelling ctx propagates into any active retry/sleep and Run
// returns as soon as the current Reconcile observes the cancel.
func (r *Reconciler) Run(ctx context.Context, tickInterval time.Duration) {
	var tickC <-chan time.Time
	if tickInterval > 0 {
		t := time.NewTicker(tickInterval)
		defer t.Stop()
		tickC = t.C
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-r.requestCh:
			r.runOneTick(ctx)
		case <-tickC:
			r.runOneTick(ctx)
		}
	}
}

// runOneTick is Run's per-iteration body: calls Reconcile and
// records the per-tick error visibility surface. Pulled out so the
// signal-driven and ticker-driven paths share the same observability
// without duplicating bookkeeping.
//
// On error: lastTickErr / lastTickErrAt / tickErrCount are bumped.
// On success: lastTickErr is CLEARED (a stale lingering error from
// a previous failed tick would mislead the mgmt UI into showing red
// while the loop is actually healthy). lastTickErrAt and the count
// are preserved on success as historical anchors.
func (r *Reconciler) runOneTick(ctx context.Context) {
	err := r.Reconcile(ctx)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.lastTickErr = err
		r.lastTickErrAt = time.Now()
		r.tickErrCount++
		return
	}
	r.lastTickErr = nil
}

// RunOnce performs a single synchronous reconcile tick — the entry
// point the cold-safety startup sequence (§3.7 D10 (a) step 7) uses
// to drive a deterministic "PUT every Desired entry once" pass
// before declaring syncthingBackendReady.
//
// Semantics:
//   - Internally calls Reconcile(ctx) directly; does NOT touch the
//     RequestReconcile signal channel.
//   - Returns Reconcile's error verbatim. Sources per D10 (a) step
//     7: (a) GetConfig failed; (b) PutFolder retry budget exhausted
//     for some folder; (c) global state-machine anomaly. Reconcile-
//     internal transient failures that the retry budget absorbed
//     return nil — that's the normal path.
//   - Updates lastTickErr / lastTickErrAt / tickErrCount on the
//     same fields the Run loop populates, so the mgmt status
//     surface reflects the most recent tick regardless of who
//     drove it.
//
// Caller (PR1.3b-3 StartupRebuild → PR1.3b-4 main) MUST also check
// IsBlocked() AFTER RunOnce returns: a nil-error tick can still
// leave folders in Blocked terminal (per §4.5 lease/blocked state
// machine), and readiness must refuse to flip in that case. See
// D10 (b) "key invariant: syncthingBackendReady=true ⇒ scrub-done".
func (r *Reconciler) RunOnce(ctx context.Context) error {
	err := r.Reconcile(ctx)
	r.mu.Lock()
	if err != nil {
		r.lastTickErr = err
		r.lastTickErrAt = time.Now()
		r.tickErrCount++
	} else {
		r.lastTickErr = nil
	}
	r.mu.Unlock()
	return err
}

// LastReconcileError returns the error from the most recent Run loop
// iteration, or nil if the most recent iteration succeeded (or Run
// hasn't fired yet). For mgmt /v1/status surface.
//
// Manual Reconcile calls (tests, operator retries via OperatorRetry)
// do NOT update this — they return errors directly to the caller.
// Only the Run loop AND RunOnce populate it.
func (r *Reconciler) LastReconcileError() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastTickErr
}

// LastReconcileErrorAt returns the wall-clock time of the most recent
// errored Run iteration, or zero time if Run has never errored.
// Preserved across success-after-failure so operators can see the
// "this is when it last had trouble" anchor in the status UI.
func (r *Reconciler) LastReconcileErrorAt() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastTickErrAt
}

// ReconcileErrorCount returns the cumulative number of Run iterations
// that errored over the reconciler's lifetime. Monotonic; only
// incremented on Run errors (not on manual Reconcile errors). For
// mgmt status surface — pairs with LastReconcileError to distinguish
// "one transient hiccup" from "every tick fails."
func (r *Reconciler) ReconcileErrorCount() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tickErrCount
}

// UpdateDesiredFolder upserts a single folder in the desired state,
// leaving other folders untouched. Used by per-session hooks
// (Lease.onClose) that must mutate only their own folder without
// stomping on other sessions' desired state — SetDesired is too
// blunt for that because it replaces the entire Folders slice.
//
// Like SetDesired, this validates the folder ID is non-empty.
// Per-field validity (Type ∈ {sendonly, ...}, devices uniqueness)
// is enforced at PutFolder time via Folder.Validate; this method
// only catches the structural error.
//
// Concurrent UpdateDesiredFolder / RemoveDesiredFolder calls
// serialize on the same mutex as SetDesired / Desired. The
// reconciler's Reconcile loop reads desired under that mutex too,
// so mid-tick mutations are safe — they take effect on the NEXT
// iteration.
func (r *Reconciler) UpdateDesiredFolder(d DesiredFolder) error {
	if d.ID == "" {
		return fmt.Errorf("syncthing: UpdateDesiredFolder requires non-empty Folder.ID")
	}
	clone := d
	if len(d.Devices) > 0 {
		clone.Devices = append([]Device(nil), d.Devices...)
	} else {
		clone.Devices = nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.desired.Folders {
		if r.desired.Folders[i].ID == d.ID {
			r.desired.Folders[i] = clone
			return nil
		}
	}
	r.desired.Folders = append(r.desired.Folders, clone)
	return nil
}

// RemoveDesiredFolder removes a single folder from the desired state.
// Returns true iff a matching entry was removed.
//
// Used at the end of a session lifecycle when the workspace is fully
// detached and should not be reconciled against the actual config
// (the next tick will treat the folder as unknown and quarantine it
// via the §4.5 mechanism, which is the desired fail-closed behaviour
// for an abandoned membership — see migration §4.4 Same-machine
// disconnect path).
func (r *Reconciler) RemoveDesiredFolder(folderID string) bool {
	if folderID == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, f := range r.desired.Folders {
		if f.ID == folderID {
			r.desired.Folders = append(r.desired.Folders[:i], r.desired.Folders[i+1:]...)
			return true
		}
	}
	return false
}

// MarkDesiredCleanup is the per-folder fail-closed mutation:
// transitions an existing DesiredFolder into cleanup state with
// Paused=true and Devices=[{serverSelfDevice}], while PRESERVING
// every other Kari-owned sibling field (Path / Type / Label / any
// future field). Used by Lease.onClose hooks (cmd/server/revoke.go's
// buildSyncLease) to apply the §4.1 + §4.4 fail-closed action
// against Desired without going through UpdateDesiredFolder, which
// is whole-replace and would silently drop missing fields when the
// caller passes a half-struct like `{ID, Paused:true}`.
//
// The half-struct path is the round-2 review Blocking that motivated
// this helper — see migration plan §3.7 D8 for the full rationale.
// PR1.3b MUST use MarkDesiredCleanup; UpdateDesiredFolder remains
// the right API only for fully-formed Desired writes (e.g. startup
// rebuild from workspaces table).
//
// Returns an error iff:
//   - folderID is empty (caller misuse)
//   - serverSelfDevice is empty (cleanup MUST retain server-self;
//     an empty Devices array would either quarantine via the §4.5
//     unknown-folder path OR — once the real RestClient lands —
//     remove the server's own access to its own folder, neither
//     of which is what cleanup means)
//   - folderID has no current Desired entry (fail loud over fail
//     silent per §3.7 D8: Lease.onClose firing without a Desired
//     entry usually means PR1.3b startup-rebuild hasn't run or
//     buildSyncLease's wiring is out of order — surface it)
//
// Safe for concurrent use; serializes on the same mutex as
// SetDesired / UpdateDesiredFolder / RemoveDesiredFolder.
func (r *Reconciler) MarkDesiredCleanup(folderID, serverSelfDevice string) error {
	if folderID == "" {
		return fmt.Errorf("syncthing: MarkDesiredCleanup requires non-empty folderID")
	}
	if serverSelfDevice == "" {
		return fmt.Errorf("syncthing: MarkDesiredCleanup requires non-empty serverSelfDevice (folder_id=%q)", folderID)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.desired.Folders {
		if r.desired.Folders[i].ID == folderID {
			r.desired.Folders[i].Paused = true
			r.desired.Folders[i].Devices = []Device{{DeviceID: serverSelfDevice}}
			// Path / Type / Label / any future Kari-owned field
			// stay put — this is the entire point of the helper.
			return nil
		}
	}
	return fmt.Errorf("syncthing: MarkDesiredCleanup: folder_id=%q has no current Desired entry", folderID)
}

// Reconcile performs one drift-detect + repair tick. Returns nil on a
// clean run OR on a run that detected drift and wrote corrections
// successfully. Returns a wrapped error if a PutFolder / PutOptions
// retry loop exhausts itself and the reconciler enters blocked state.
//
// GetConfig failures are surfaced as-is and do NOT enter blocked —
// we couldn't even observe the config, so the corrective writes
// would have failed too. The caller (tick loop) will retry next tick.
//
// Reconcile is serialized against itself and against OperatorRetry
// via the reconciler's runMu (see type doc). Calling Reconcile from
// inside an OnDrift / OnBlock handler will deadlock; tick loops
// must arrange to drop the call into a separate goroutine if they
// need re-entrant fan-out.
func (r *Reconciler) Reconcile(ctx context.Context) error {
	r.runMu.Lock()
	defer r.runMu.Unlock()
	return r.reconcileLocked(ctx)
}

// reconcileLocked is Reconcile's body assuming runMu is held by the
// caller. Reconcile and OperatorRetry both lock runMu around it; do
// NOT call this without holding runMu.
func (r *Reconciler) reconcileLocked(ctx context.Context) error {
	r.mu.Lock()
	desired := r.desired
	blocked := r.blocked
	r.mu.Unlock()

	cfg, err := r.client.GetConfig(ctx)
	if err != nil {
		return fmt.Errorf("syncthing: reconcile GetConfig: %w", err)
	}

	actualByID := make(map[string]Folder, len(cfg.Folders))
	for _, f := range cfg.Folders {
		actualByID[f.ID] = f
	}
	desiredByID := make(map[string]DesiredFolder, len(desired.Folders))
	for _, d := range desired.Folders {
		desiredByID[d.ID] = d
	}

	// anyRepairThisTick tracks whether ANY corrective write happened
	// in this tick — global options, unknown-folder quarantine, or
	// per-folder cleanup. Forward (unpause / new membership / add
	// device) writes are gated behind !anyRepairThisTick because
	// migration §4.5 step 5 says "any config inconsistency repair →
	// no unpause same tick" — i.e. it's NOT just about per-folder
	// cleanup. Options drift being repaired is enough on its own to
	// defer any forward writes to the next clean tick.
	anyRepairThisTick := false

	// ===== 1. Global options drift =====
	if cfg.Options != desired.Options {
		r.emitDrift(DriftEvent{
			Kind:   DriftKindOptions,
			Detail: fmt.Sprintf("actual=%+v desired=%+v", cfg.Options, desired.Options),
		})
		if err := r.putOptionsWithRetry(ctx, desired.Options); err != nil {
			return err
		}
		anyRepairThisTick = true
	}

	// ===== 2. Unknown folders → quarantine (cleanup direction) =====
	// Iterate in sorted order so any emitted events / tests are
	// deterministic.
	var unknownIDs []string
	for id := range actualByID {
		if _, ok := desiredByID[id]; ok {
			continue
		}
		unknownIDs = append(unknownIDs, id)
	}
	sort.Strings(unknownIDs)
	for _, id := range unknownIDs {
		actual := actualByID[id]
		r.emitDrift(DriftEvent{
			FolderID: id,
			Kind:     DriftKindUnknownFolder,
			Detail:   fmt.Sprintf("path=%s devices=%d", actual.Path, len(actual.Devices)),
		})
		if actual.Paused {
			// Already paused — quarantine state met. Don't write.
			continue
		}
		paused := actual
		paused.Paused = true
		if err := r.putFolderWithRetry(ctx, paused); err != nil {
			return err
		}
		anyRepairThisTick = true
	}

	// ===== 3. Per-folder cleanup pass =====
	// Plans are computed once against the snapshot; each folder is
	// classified as cleanup-only / forward-only / both. We do all
	// cleanup writes first so any cleanup anywhere this tick blocks
	// all forward writes from happening in the same tick
	// (migration §4.5 step 5).
	type plan struct {
		desired   DesiredFolder
		actual    Folder
		exists    bool
		flags     []string
		isCleanup bool
		isForward bool
	}
	plans := make([]plan, 0, len(desired.Folders))
	for _, d := range desired.Folders {
		actual, exists := actualByID[d.ID]
		p := plan{desired: d, actual: actual, exists: exists}
		if !exists {
			// Missing folder → must be created. Forward direction.
			p.isForward = true
			p.flags = []string{DriftKindMissingFolder}
			plans = append(plans, p)
			continue
		}
		flags, cleanup, forward := diffFolder(actual, desiredFolderToFolder(d))
		if len(flags) == 0 {
			continue
		}
		p.flags = flags
		p.isCleanup = cleanup
		p.isForward = forward
		plans = append(plans, p)
	}

	// Emit drift events for all plans up front, before any writes.
	// That way an OnDrift handler that crashes doesn't make the
	// subset of folders that drifted invisible.
	for _, p := range plans {
		for _, flag := range p.flags {
			r.emitDrift(DriftEvent{FolderID: p.desired.ID, Kind: flag})
		}
	}

	// Cleanup writes. NOT gated by blocked — migration §4.5 explicitly
	// keeps cleanup direction open during blocked so a stray device
	// (cross-workspace leak risk) doesn't sit on disk waiting for
	// operator retry.
	for _, p := range plans {
		if !p.isCleanup {
			continue
		}
		safe := buildCleanupFolder(p.actual, p.desired)
		if err := r.putFolderWithRetry(ctx, safe); err != nil {
			return err
		}
		anyRepairThisTick = true
	}

	// ===== 4. Forward pass =====
	// Forward writes (unpause, add device, create folder) require:
	//   - !blocked
	//   - no cleanup write happened earlier this tick
	for _, p := range plans {
		if p.isCleanup {
			// Same folder did cleanup → forward portion deferred to
			// next tick (the "下 tick 全等才恢复" rule).
			continue
		}
		if !p.isForward {
			continue
		}
		if blocked {
			continue
		}
		if anyRepairThisTick {
			continue
		}
		if !p.exists {
			if err := r.putFolderWithRetry(ctx, desiredFolderToFolder(p.desired)); err != nil {
				return err
			}
			continue
		}
		if err := r.putFolderWithRetry(ctx, desiredFolderToFolder(p.desired)); err != nil {
			return err
		}
	}

	return nil
}

// OperatorRetry clears the blocked latch and runs one Reconcile.
// Called by mgmt admin endpoint (PR1.2b leaves the HTTP plumbing
// out; this is just the kernel).
//
// Semantics:
//   - Reconciler not blocked: returns ErrBlocked wrapped with a
//     "not currently blocked" message. No state change.
//   - Reconcile succeeds: blocked latch stays cleared, coldSafetyFailed
//     counter resets to zero.
//   - Reconcile fails AFTER a PUT failure (re-enters blocked via
//     enterBlocked): blocked is set again with the new failure reason
//     and counter is bumped. We return the wrapped ErrBlocked.
//   - Reconcile fails BEFORE any PUT attempt (e.g. GetConfig error,
//     ctx cancel): enterBlocked has NOT been called, so we restore
//     the prior blocked / blockReason latch ourselves. Without this,
//     a transient GetConfig failure during retry would silently clear
//     a terminal blocked state — the exact opposite of what we want.
//     The coldSafetyFailed counter is NOT bumped on this path (no
//     new fail-closed event occurred).
//
// Concurrency: OperatorRetry holds runMu for the entire
// clear-latch + reconcile + restore-on-fail sequence, so it cannot
// interleave with a concurrent Reconcile. The "not currently blocked"
// check and the latch clear therefore observe a consistent view.
func (r *Reconciler) OperatorRetry(ctx context.Context) error {
	r.runMu.Lock()
	defer r.runMu.Unlock()

	r.mu.Lock()
	if !r.blocked {
		r.mu.Unlock()
		return fmt.Errorf("%w: not currently blocked", ErrBlocked)
	}
	priorReason := r.blockReason
	r.blocked = false
	r.blockReason = ""
	r.mu.Unlock()

	if err := r.reconcileLocked(ctx); err != nil {
		// If reconcileLocked re-entered blocked via enterBlocked,
		// that latch is already set with a fresh reason — leave it.
		// If not (GetConfig error, ctx cancel, etc.), restore the
		// prior terminal state so we don't silently clear it.
		r.mu.Lock()
		if !r.blocked {
			r.blocked = true
			r.blockReason = priorReason
		}
		r.mu.Unlock()
		return err
	}
	r.mu.Lock()
	r.coldSafetyFailed = 0
	r.mu.Unlock()
	return nil
}

func (r *Reconciler) emitDrift(ev DriftEvent) {
	r.mu.Lock()
	fn := r.onDrift
	r.mu.Unlock()
	if fn != nil {
		fn(ev)
	}
}

// enterBlocked marks the reconciler blocked. Idempotent — subsequent
// calls only update blockReason (so the most recent failure surfaces).
func (r *Reconciler) enterBlocked(reason string) {
	r.mu.Lock()
	already := r.blocked
	r.blocked = true
	r.blockReason = reason
	if !already {
		r.coldSafetyFailed++
	}
	fn := r.onBlock
	r.mu.Unlock()
	if !already && fn != nil {
		fn(reason)
	}
}

func (r *Reconciler) putFolderWithRetry(ctx context.Context, f Folder) error {
	return r.retry(ctx, func(ctx context.Context) error {
		return r.client.PutFolder(ctx, f)
	}, fmt.Sprintf("PutFolder(%s)", f.ID))
}

func (r *Reconciler) putOptionsWithRetry(ctx context.Context, opts ConfigOptions) error {
	return r.retry(ctx, func(ctx context.Context) error {
		return r.client.PutOptions(ctx, opts)
	}, "PutOptions")
}

func (r *Reconciler) retry(ctx context.Context, fn func(context.Context) error, what string) error {
	r.mu.Lock()
	backoffs := r.backoffs
	if backoffs == nil {
		backoffs = defaultBackoffs
	}
	r.mu.Unlock()

	var lastErr error
	for _, delay := range backoffs {
		if delay > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
		err := fn(ctx)
		if err == nil {
			return nil
		}
		lastErr = err
	}
	reason := fmt.Sprintf("%s failed after %d attempts: %v", what, len(backoffs), lastErr)
	r.enterBlocked(reason)
	return fmt.Errorf("%w: %s", ErrBlocked, reason)
}

// diffFolder compares an observed folder against the desired form and
// returns (flag list, isCleanupDirection, isForwardDirection).
//
// Direction classification rule:
//   - Removing-something-from-actual = cleanup (stray devices,
//     pausing, type/path correction toward desired).
//   - Adding-something = forward (missing devices, unpausing).
//
// A single folder can be both: e.g. stray device (cleanup) + paused
// mismatch toward unpause (forward). The reconciler handles such
// folders by writing the cleanup-version only in the current tick
// and deferring the forward portion to the next clean tick.
func diffFolder(actual, desired Folder) (flags []string, cleanup, forward bool) {
	if stray := devicesOnlyInA(actual.Devices, desired.Devices); len(stray) > 0 {
		flags = append(flags, DriftKindStrayDevices)
		cleanup = true
	}
	if missing := devicesOnlyInA(desired.Devices, actual.Devices); len(missing) > 0 {
		flags = append(flags, DriftKindMissingDevices)
		forward = true
	}
	if actual.Paused != desired.Paused {
		if desired.Paused {
			flags = append(flags, DriftKindPausedWantTrue)
			cleanup = true
		} else {
			flags = append(flags, DriftKindPausedWantFalse)
			forward = true
		}
	}
	if actual.Type != desired.Type {
		flags = append(flags, DriftKindType)
		// Type drift is rare and dangerous (e.g. config edit changing
		// sendonly → sendreceive bypasses bootstrap mode). Treat as
		// cleanup so the same tick pauses + restores type.
		cleanup = true
	}
	if actual.Path != desired.Path {
		flags = append(flags, DriftKindPath)
		// Path drift can only happen via direct config edit (mgmt
		// rename is forbidden under syncthing backend — see migration
		// §2.1 workspace_name immutable). Cleanup direction.
		cleanup = true
	}
	return
}

// buildCleanupFolder produces the safe-version PutFolder body for a
// cleanup write: paused=true, devices = actual ∩ desired (strays
// removed but missing NOT added — adding is forward direction), type
// and path forced to desired.
func buildCleanupFolder(actual Folder, desired DesiredFolder) Folder {
	out := actual
	out.Paused = true
	out.Type = desired.Type
	out.Path = desired.Path
	out.Label = desired.Label
	out.Devices = intersectDevices(actual.Devices, desired.Devices)
	return out
}

func desiredFolderToFolder(d DesiredFolder) Folder {
	return Folder{
		ID:      d.ID,
		Path:    d.Path,
		Type:    d.Type,
		Label:   d.Label,
		Paused:  d.Paused,
		Devices: append([]Device(nil), d.Devices...),
	}
}

// devicesOnlyInA returns the entries of a whose DeviceID does not
// appear in b. Order from a is preserved.
func devicesOnlyInA(a, b []Device) []Device {
	bSet := make(map[string]struct{}, len(b))
	for _, d := range b {
		bSet[d.DeviceID] = struct{}{}
	}
	var out []Device
	for _, d := range a {
		if _, ok := bSet[d.DeviceID]; !ok {
			out = append(out, d)
		}
	}
	return out
}

// intersectDevices returns the entries of a whose DeviceID appears in
// b. Order from a preserved.
func intersectDevices(a, b []Device) []Device {
	bSet := make(map[string]struct{}, len(b))
	for _, d := range b {
		bSet[d.DeviceID] = struct{}{}
	}
	var out []Device
	for _, d := range a {
		if _, ok := bSet[d.DeviceID]; ok {
			out = append(out, d)
		}
	}
	return out
}
