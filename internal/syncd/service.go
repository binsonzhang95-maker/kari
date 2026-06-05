package syncd

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"sort"

	"github.com/binsonzhang95-maker/kari/internal/execpolicy"
	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/gitutil"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

type BindRequest struct {
	WorkspaceRoot string `json:"workspace_root"`
	ServerAddr    string `json:"server_addr"`
	WorkspaceID   string `json:"workspace_id"`
	// ActivationCode is the single shared secret. The single-tenant
	// server derives the same transport key from it (SHA-256(secret)),
	// so every client that knows the secret can attach; workspace_id only
	// isolates trees, it is not a per-tenant key. Named "activation_code"
	// for wire-compat with the desktop client's bind body.
	ActivationCode string `json:"activation_code"`
	// ClientID is the caller's stable identifier. The server uses it to
	// tell "same client reconnecting" from "another client taking over"
	// and to send a session_replaced kick to the loser.
	ClientID      string `json:"client_id,omitempty"`
	RescanSeconds int    `json:"rescan_seconds"`
	// StagingID, BindKind, SyncBackend describe the Desktop-side
	// staging operation that produced this bind. They are forwarded
	// verbatim from Desktop's bind body (B5 / B6c) and consumed by
	// /v1/sync-verify so Desktop can correlate the verify response with
	// the staging_id it polled with. All three are optional — older
	// Desktop clients omit them; Go json silently drops unknown fields,
	// so a daemon built with these fields against an older Desktop just
	// sees zero-value strings. None of these affect transport behavior.
	StagingID   string `json:"staging_id,omitempty"`
	BindKind    string `json:"bind_kind,omitempty"`
	SyncBackend string `json:"sync_backend,omitempty"`
	// WorkspaceName, when non-empty, is the canonical logical name
	// the daemon advertises to trans-server in its sync hello — taking
	// precedence over the path-basename heuristic in
	// resolveWorkspaceNameLocked. The basename fallback was the
	// production bug surfaced by snapshot DOWNLOAD: Desktop binds
	// daemon to a fresh local staging dir
	// (~/.../staging-download/download-<sid>/) and expects trans-server
	// to serve files from /sync/<workspace_id>/<canonical-project>/.
	// Without WorkspaceName, daemon resolves "download-<sid>" from the
	// path basename, server serves an empty /sync/<wsid>/download-<sid>/
	// dir → peer_files=0, empty_peer_download barrier fires immediately,
	// sync_task succeeds with 83 bytes (.gitignore default), nothing
	// real downloaded. Upload was unaffected because daemon pushes
	// files INTO the staging dir of the same name on both sides.
	// Empty (older Desktop clients that omit this field) keeps the
	// legacy basename behaviour — no regression.
	WorkspaceName string `json:"workspace_name,omitempty"`
}

type Service struct {
	mu sync.Mutex

	bind          BindRequest
	workspaceName string
	// bindEpoch increments by one on every successful Bind. Read by
	// CurrentBindMetadata together with bind/workspaceName under mu so
	// /v1/sync-verify can detect an A→B→A bind sequence (which would
	// otherwise pass the snapshot-1 == snapshot-2 value comparison and
	// let the handler return task/status data observed mid-B). Pure
	// monotonic counter; never reset.
	bindEpoch uint64

	running bool
	cancel  context.CancelFunc

	status              Status
	remoteActivityAt    map[string]time.Time
	workspaceNameByRoot map[string]string
	workspaceNameInUse  map[string]struct{}
	now                 func() time.Time
	// kickChan is non-nil while a run loop is alive; TriggerSync drops
	// a non-blocking signal onto it so the session's engine.Watch can
	// run changedPaths immediately instead of waiting for the rescan
	// ticker. Wired in PR-C2.
	kickChan chan struct{}
	// activeSession is non-nil while a sync session is connected. The
	// HTTP /v1/bootstrap handler grabs this to queue a MessageBootstrap
	// onto the live wire — no fallback if disconnected (operator just
	// retries after re-connect).
	activeSession *filesync.Session
	// bootstrapInFlight mirrors the request lifecycle at the daemon
	// layer so repeated HTTP calls cannot overwrite pending state while
	// the server clone is still running.
	bootstrapInFlight bool
	// incomingHistory captures pre-image bytes of files about to be
	// overwritten/deleted by an inbound sync, so the VS Code extension
	// can render gutter diff bars. One per bound workspace; nil before
	// Bind() or when the storage dir cannot be created.
	incomingHistory *IncomingHistory
	// remoteSessionsCache memoises ListRemoteSessions replies per cache key
	// (workspace root + requested sources) so the extension can render the
	// history TreeView without hitting the server on every refresh tick. A
	// map (not a single slot) so distinct keys — different source filters, or
	// the same daemon across a workspace switch — don't evict each other.
	// TTL is short (30s) so fresh sessions show up promptly. Cleared on Stop()
	// and on workspace rebinds (Bind() rootChanged path) — the same places
	// incomingHistory is reset.
	remoteSessionsCache map[string]remoteSessionsCacheEntry
	ptyCounts              map[string]int
	// execPolicy + execBasePath drive the local-exec MCP bridge runner.
	// Loaded lazily on first session start and shared across reconnects.
	// nil execPolicy means the bridge feature is disabled — typically
	// because the platform doesn't support process-group cancellation
	// (Windows v1) or because operator opted out via env var.
	execPolicy   *execpolicy.Loader
	execBasePath string
	// syncTasks tracks user-initiated sync intents (POST
	// /v1/sync-tasks). Lazily created on first access via
	// ensureSyncTasksLocked; see sync_task_service.go for the glue.
	// nil before first use.
	syncTasks *SyncTaskManager
	// pausedDownloads remembers "user cancelled download for this
	// workspace; do not resume on session reconnect" across session
	// rebuilds. Pre-fix the cancel state lived only on the
	// then-current Session.outboundStopped flag; any reconnect
	// (server bounce, network blip, daemon-side session rebuild)
	// produced a fresh Session with outboundStopped=false and the
	// new session's initial MessageManifest re-triggered the
	// server's DiffManifest + outbound.enqueue — download silently
	// resumed even though the UI still showed "已取消" (Codex round
	// 6 blocking). Now the daemon tracks paused workspaces here:
	//   - CancelSyncTask marks paused
	//   - CreateSyncTask (download direction) clears paused
	//   - runOnce checks paused before binding a session; if paused,
	//     SetStartPaused(true) on the new session so it skips the
	//     initial manifest send AND queues an immediate Cancel so
	//     the peer's new session also enters stopped state
	// Keyed by workspace_name (matches the SyncTask.WorkspaceName
	// field). mu-guarded.
	pausedDownloads map[string]bool
	// stagingFinalizeFired is the one-shot latch for L2 sub-commit D's
	// staging-bind auto-release. Once a staging-bind (upload-staging /
	// download-staging) sync_task transitions to succeeded AND the
	// grace period (stagingFinalizeGrace) elapses without Desktop
	// rebinding or starting a new task, daemon calls Stop() to release
	// the run loop. Without this auto-release, Desktop's broken
	// post-commit lifecycle (does not unbind daemon from staging dir
	// after commitManifest succeeds) leaves daemon spinning forever:
	// engine.Watch rescans every 30s on the now-empty staging dir,
	// surfaces 89 missing-file events, sub-commit C suppresses them
	// outbound — fine for wipe prevention, but Status.workspace_root
	// stays pointing at the staging path, Desktop UI sees
	// last_sync_at=zero and marks "sync failed," and inbound files
	// from the server land in a dir Desktop already deleted.
	// Reset on Bind() (each new bind gets a fresh latch).
	// mu-guarded.
	stagingFinalizeFired bool
	// Auto-snapshot Phase 1 — Desktop-driven dirty tracking.
	// Daemon is a pure state machine here: Desktop calls
	// /v1/auto-snapshot/notify on every local change it detects
	// (Desktop already has fs watching for UI dot rendering, so it
	// has the natural detection point); daemon tracks "dirty" +
	// debounce + min-interval. /v1/status reflects
	// auto_snapshot_due so Desktop can poll once per second and
	// decide whether to fire the Upload pipeline. After upload
	// commits, Desktop calls /v1/auto-snapshot/ack to reset.
	//
	// Reset ONLY on a workspace switch (rootChanged Bind) — same-
	// root rebinds (Desktop's Upload click swapping to a staging
	// bind and back) preserve the dirty / lastChangeAt / lastAckAt
	// so the auto-snapshot cycle survives intermediate binds.
	// Future work: deletion-ratio guard, long-running escape valve,
	// per-project pause toggle persistence.
	autoSnapshotDirty        bool
	autoSnapshotLastChangeAt time.Time
	autoSnapshotLastAckAt    time.Time
}

// Auto-snapshot Phase 1 tunables. Var (not const) so tests can shrink.
// Default 3s quiet window + 30s min interval between fires matches the
// brainstorm spec — typical save/edit cadence converges fast, but a
// dev-server writing files every second won't spam the upload pipeline.
var (
	autoSnapshotDebounce    = 3 * time.Second
	autoSnapshotMinInterval = 30 * time.Second
)

// stagingFinalizeGrace is how long daemon waits after a staging-bind
// sync_task hits succeeded before auto-releasing. Long enough for a
// well-behaved Desktop to issue its post-commit rebind to the
// workspace path (typically <1s of clean lifecycle code). Short enough
// that a buggy Desktop doesn't strand the user looking at a "sync
// failed" badge for long. Var (not const) so tests can shrink.
var stagingFinalizeGrace = 15 * time.Second

// remoteSessionsCacheTTL is the in-memory cache lifetime for
// /v1/remote-sessions replies. var (not const) so tests can shrink it.
var remoteSessionsCacheTTL = 30 * time.Second

// remoteSessionsCacheEntry is one memoised ListRemoteSessions reply.
type remoteSessionsCacheEntry struct {
	result transport.ListSessionsResult
	at     time.Time
}

// remoteSessionsRequestTimeout caps how long ListRemoteSessions blocks
// waiting for the server's reply before returning an error. Server
// scans typically complete in <100ms but a slow disk or huge ~/.codex
// could push it; 15s is the same upper bound bootstrap uses.
var remoteSessionsRequestTimeout = 15 * time.Second

func NewService() *Service {
	return &Service{
		status:              Status{},
		remoteActivityAt:    map[string]time.Time{},
		workspaceNameByRoot: map[string]string{},
		workspaceNameInUse:  map[string]struct{}{},
		ptyCounts:           map[string]int{},
		now:                 time.Now,
		pausedDownloads:     map[string]bool{},
	}
}

// markDownloadPaused / clearDownloadPaused / isDownloadPaused are
// the lifecycle of the cross-session cancel flag. mu-guarded so the
// HTTP-route goroutine (CancelSyncTask / CreateSyncTask) and the
// run-loop goroutine (runOnce session bind) can call them safely.
func (s *Service) markDownloadPaused(workspaceName string) {
	if workspaceName == "" {
		return
	}
	s.mu.Lock()
	s.pausedDownloads[workspaceName] = true
	s.mu.Unlock()
}

func (s *Service) clearDownloadPaused(workspaceName string) {
	if workspaceName == "" {
		return
	}
	s.mu.Lock()
	delete(s.pausedDownloads, workspaceName)
	s.mu.Unlock()
}

func (s *Service) isDownloadPaused(workspaceName string) bool {
	if workspaceName == "" {
		return false
	}
	s.mu.Lock()
	paused := s.pausedDownloads[workspaceName]
	s.mu.Unlock()
	return paused
}

// ensureExecBridgeLoadedLocked initialises the policy loader and
// resolves the user-shell PATH the first time a sync session is about
// to start. Called from runOnce with s.mu held. No-op on platforms
// that don't support the bridge (Windows v1) so the session never
// advertises CapabilityLocalExec there — see exec_windows.go.
func (s *Service) ensureExecBridgeLoadedLocked() {
	if !localExecPlatformSupported() {
		return
	}
	if s.execPolicy != nil {
		return
	}
	path := execpolicy.DefaultPolicyPath()
	if path == "" {
		log.Printf("local exec bridge: cannot resolve $KARI_HOME, bridge disabled")
		return
	}
	if err := execpolicy.EnsureDefaultPolicyFile(path); err != nil {
		log.Printf("local exec bridge: default policy file %s not writable: %v", path, err)
	}
	s.execPolicy = execpolicy.NewLoader(path)
	// Touch-load now so a malformed file gets flagged at startup rather
	// than only when the first MCP tool call lands. The error is
	// informational — Decide will return DeniedPolicyLoad anyway when a
	// request arrives, so the daemon can run without the file (every
	// request gets denied until the operator fixes it).
	if _, err := s.execPolicy.Load(); err != nil {
		log.Printf("local exec bridge: policy file %s not loadable yet: %v (commands will be denied until fixed)", path, err)
	}
	s.execBasePath = BootstrapLocalExecPath()
}

func (s *Service) Bind(req BindRequest) error {
	if req.WorkspaceRoot == "" || req.ServerAddr == "" || req.WorkspaceID == "" || req.ActivationCode == "" {
		return errors.New("workspace_root, server_addr, workspace_id, activation_code are required")
	}
	if req.RescanSeconds <= 0 {
		req.RescanSeconds = 30
	}

	newRoot := filepath.Clean(strings.TrimSpace(req.WorkspaceRoot))

	// Reject the bind up front if the path doesn't point at a real
	// directory. Without this check, runOnce silently spins up an engine
	// rooted at a nonexistent path, scan() returns empty (PR-B1 now
	// suppresses the ENOENT into "no files"), and the user sees a
	// happy-looking "connected" status with zero files ever syncing.
	// The extension surfaces this error in the connection toast so the
	// user knows immediately that they pointed at the wrong folder.
	info, err := os.Stat(newRoot)
	if err != nil {
		return fmt.Errorf("workspace_root not accessible: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("workspace_root is not a directory: %s", newRoot)
	}

	s.mu.Lock()
	// Detect a workspace switch (e.g. user opened a different folder in
	// VS Code) and tear down the per-root state so the next Start() can
	// reconnect against the new path. Without this, the running runLoop
	// keeps the old engine/workspace_name alive forever and the new
	// folder shows up on the server but never receives its files.
	oldRoot := filepath.Clean(strings.TrimSpace(s.bind.WorkspaceRoot))
	rootChanged := s.bind.WorkspaceRoot != "" && oldRoot != newRoot
	// L2 sub-commit B (codex review fix): a SAME-ROOT bind that flips
	// the control-only state is just as dangerous as a root change. The
	// already-running runOnce captured the OLD bind at session
	// construction, so flipping bind.SyncBackend / bind.StagingID by
	// itself doesn't propagate to the live filesync.Session — new
	// CreateSyncTask calls would correctly hit the gate, but the
	// always-on session keeps doing manifest exchange + delete
	// propagation until the next reconnect. That's a fail-open window
	// for the duration of the existing session — the exact scenario
	// codex flagged. Treat any transition between control-only and
	// full-mode (in either direction) as equivalent to a root change:
	// cancel the run loop and rebuild on the next Start.
	//
	// Examples this catches:
	//   - filesync workspace → upgraded to syncthing backend → must
	//     cancel legacy session before it propagates more deletes
	//   - syncthing workspace-bind (control-only) → user clicks Upload
	//     → Bind() arrives with staging_id set → must rebuild session
	//     so staging-upload actually transfers files
	//   - syncthing upload-staging → snapshot complete → workspace-bind
	//     resumes without staging_id → must rebuild into control-only
	wasControlOnly := isControlOnlyBind(s.bind)
	willBeControlOnly := isControlOnlyBind(req)
	controlOnlyFlipped := s.bind.WorkspaceRoot != "" && wasControlOnly != willBeControlOnly
	// Cancel the running session whenever the file plane's behavior must
	// change — either workspace root switched or control-only state
	// flipped. The capture-at-construction model of runOnce means the
	// session uses the OLD bind for its entire lifetime; without a
	// cancel here, a same-root flip would leave the legacy file plane
	// running until the next reconnect (the fail-open codex flagged).
	if rootChanged || controlOnlyFlipped {
		// CancelFunc is non-blocking; calling it under the lock is fine
		// and guarantees the old run loop is signalled even if the rest
		// of Bind() returns early.
		if s.cancel != nil {
			s.cancel()
		}
		s.cancel = nil
		s.kickChan = nil
		s.running = false
		s.status.Running = false
		s.status.Connected = false
		s.activeSession = nil
		s.bootstrapInFlight = false
	}
	// Root change additionally nukes the workspace-tied state (review /
	// git / incoming-history / frpc / name caches). control-only flip
	// alone preserves those — the workspace is the same; only the file
	// plane's session lifecycle is changing.
	if rootChanged {
		s.incomingHistory = nil
		s.remoteSessionsCache = nil
		s.remoteActivityAt = map[string]time.Time{}
		s.ptyCounts = map[string]int{}
		s.status.RemoteEditingPaths = nil
		s.status.PtyCount = 0
		s.status.LastBootstrap = BootstrapState{}
	}
	s.bind = req
	// L2 sub-commit D: every new bind resets the staging-finalize
	// latch. Without this reset, a SAME-ROOT rebind from workspace →
	// staging (Upload click) would carry the prior latch state and
	// either fire prematurely or never fire on the new staging task.
	s.stagingFinalizeFired = false
	// Auto-snapshot Phase 1: reset state ONLY on a workspace switch
	// (rootChanged). Same-root rebinds — Desktop swapping to an
	// upload-staging bind during an Upload click, then back to the
	// workspace bind post-commit — must PRESERVE the dirty / change /
	// ack timestamps so the auto-snapshot cycle survives those
	// intermediate binds. Codex Phase-1 MUST-FIX: without this
	// guard, Desktop's Upload click would clobber the dirty flag that
	// drove the fire decision, and subsequent edits during upload
	// would be lost across the staging-bind→workspace-bind transition.
	if rootChanged {
		s.autoSnapshotDirty = false
		s.autoSnapshotLastChangeAt = time.Time{}
		s.autoSnapshotLastAckAt = time.Time{}
	}
	// Bind body's workspace_name wins when provided. Falls back to the
	// path-basename heuristic for back-compat with older callers that
	// don't send the field. See BindRequest.WorkspaceName comment for
	// the production motivation (snapshot download empty_peer_download
	// bug).
	if explicit := strings.TrimSpace(req.WorkspaceName); explicit != "" {
		s.workspaceName = explicit
		// Mirror the in-use bookkeeping the basename path does, so
		// the next workspace-name resolution against the same root
		// doesn't accidentally allocate a different name.
		if s.workspaceNameByRoot == nil {
			s.workspaceNameByRoot = map[string]string{}
		}
		if s.workspaceNameInUse == nil {
			s.workspaceNameInUse = map[string]struct{}{}
		}
		s.workspaceNameByRoot[filepath.Clean(strings.TrimSpace(req.WorkspaceRoot))] = explicit
		s.workspaceNameInUse[explicit] = struct{}{}
	} else {
		s.workspaceName = s.resolveWorkspaceNameLocked(req.WorkspaceRoot)
	}
	s.bindEpoch++
	s.status.WorkspaceRoot = req.WorkspaceRoot
	s.status.ServerAddr = req.ServerAddr
	s.status.WorkspaceID = req.WorkspaceID
	s.status.LocalRepoURL = gitutil.WorkspaceRepoURL(req.WorkspaceRoot)
	if s.ptyCounts == nil {
		s.ptyCounts = map[string]int{}
	}
	s.status.PtyCount = s.ptyCounts[req.WorkspaceID]
	// Re-binding clears a previous "kicked" or "revoked" terminal
	// status — operator action signalled the user explicitly wants
	// this client to attach (after either being kicked by another
	// device or after the license / workspace-existence issue has been
	// resolved on the server side). Reset surface centralised so tests
	// and Bind() can't drift apart.
	s.clearTerminalStatusLocked()
	if s.incomingHistory == nil {
		s.incomingHistory = NewIncomingHistory(req.WorkspaceRoot)
	}
	s.mu.Unlock()

	// Maintain the kari-managed block in the workspace's .gitignore so
	// .kari/ and .kari-engine/ (engine bookkeeping that's per-host and
	// already excluded from sync) don't pollute git status / accidental
	// `git add .`. Done outside the lock — it's disk I/O. Idempotent;
	// no-op when the block is already current. Failures are warnings,
	// never fatal: a read-only checkout shouldn't block a bind.
	if changed, gerr := ensureGitignoreManaged(req.WorkspaceRoot); gerr != nil {
		log.Printf("gitignore: %v (continuing)", gerr)
	} else if changed {
		log.Printf("gitignore: updated %s/.gitignore (kari managed block)", req.WorkspaceRoot)
	}

	return nil
}

func (s *Service) Start() error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return nil
	}
	if s.bind.WorkspaceRoot == "" {
		s.mu.Unlock()
		return errors.New("daemon is not bound to workspace yet")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.running = true
	s.cancel = cancel
	s.status.Running = true
	s.mu.Unlock()

	go s.runLoop(ctx)
	// Sweep stale .kari/uploads/ files on a one-hour cadence so a
	// chatty workspace doesn't accumulate dropped images forever.
	go s.uploadsGCLoop(ctx)
	// Same cadence for clipboard scratch files — separate loop so the
	// retention windows can diverge (clipboard 24h vs uploads 7d).
	go s.clipboardGCLoop(ctx)
	return nil
}

func (s *Service) Stop() {
	s.mu.Lock()
	cancel := s.cancel
	s.running = false
	s.cancel = nil
	s.status.Running = false
	s.status.Connected = false
	s.remoteActivityAt = map[string]time.Time{}
	s.status.RemoteEditingPaths = nil
	s.bootstrapInFlight = false
	s.remoteSessionsCache = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Staging bind kinds. Strings match what Desktop's main.cjs sends in
// the BindRequest.bind_kind field (see kari-desktop's upload/download
// snapshot pipelines). Centralized here so the staging-specific gates
// (filesync.Session.SetDisablePauseGuard + SetSuppressOutboundDeletes
// in runOnce; the staging-finalize auto-release in tickSyncTasks)
// don't drift when a new staging kind ever joins the family.
const (
	bindKindUploadStaging   = "upload-staging"
	bindKindDownloadStaging = "download-staging"
)

// isStagingBindKind returns true when the given bind is one of the
// staging-bind kinds. Used by runOnce's session-setup switch and by
// maybeAutoReleaseStagingBind's gate. Single source of truth — codex
// sub-commit-D round-1 review NICE-TO-HAVE.
func isStagingBindKind(kind string) bool {
	return kind == bindKindUploadStaging || kind == bindKindDownloadStaging
}

// isControlOnlyBind reports whether the given BindRequest shape requires
// the daemon to run in control-only mode (no legacy filesync file plane).
// SyncBackend / StagingID are normalized via TrimSpace + EqualFold so a
// peer that sends " SYNCTHING " or "syncthing\n" can't bypass the gate.
//
// Used by runOnce (to call session.SetControlOnly before session.Run),
// by CreateSyncTask (to refuse non-staging sync tasks), by TriggerSync
// (to no-op so periodic-rescan callers don't restart file sync), and by
// the /v1/sync-once route (to refuse without falling back to TriggerSync).
// All gates call this single predicate so the rule can't drift across
// callsites — see L2 sub-commit B in plans/hidden-knitting-nest.md.
func isControlOnlyBind(b BindRequest) bool {
	return strings.EqualFold(strings.TrimSpace(b.SyncBackend), "syncthing") &&
		strings.TrimSpace(b.StagingID) == ""
}

// CurrentBindMetadata snapshots the staging_id / bind_kind / sync_backend
// of the most recent successful Bind(). Empty strings when never bound or
// when the Desktop caller omitted those fields. The bindEpoch counter is
// returned alongside so /v1/sync-verify can detect an A→B→A bind sequence
// that would otherwise pass a pure-value snapshot1 == snapshot2 check —
// the epoch monotonically increments on every Bind and is read under the
// same mu lock as the other fields, so a non-matching epoch between two
// calls means at least one Bind interleaved (codex sub-commit-2 review).
func (s *Service) CurrentBindMetadata() (stagingID, bindKind, syncBackend, workspaceName string, epoch uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bind.StagingID, s.bind.BindKind, s.bind.SyncBackend, s.workspaceName, s.bindEpoch
}

// NotifyAutoSnapshotChange records that Desktop has detected a local
// file change in the bound workspace. Phase 1 contract: Desktop already
// has fs watching for UI dot rendering, so it's the natural detection
// point; daemon just maintains the dirty flag + debounce timestamps.
// Idempotent — repeated calls during a single edit burst just bump
// lastChangeAt to push the debounce window forward.
func (s *Service) NotifyAutoSnapshotChange() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.autoSnapshotDirty = true
	s.autoSnapshotLastChangeAt = s.now()
}

// AckAutoSnapshot is called by Desktop after it has fired (or chose
// not to fire) an upload in response to auto_snapshot_due. The
// firedFor argument is the lastChangeAt timestamp Desktop observed
// from /v1/status at the moment it decided to fire — daemon uses
// this to detect notifies that arrived DURING the upload window
// (between Desktop's fire decision and this ack). Such mid-flight
// notifies must NOT have their dirty signal silently wiped — the
// next upload cycle should cover them. Codex Phase-1 MUST-FIX.
//
// If firedFor is zero (older Desktop / explicit "I'm acknowledging
// regardless of races"), fall back to the legacy unconditional
// clear.
func (s *Service) AckAutoSnapshot(firedFor time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.autoSnapshotLastAckAt = s.now()
	if firedFor.IsZero() || !s.autoSnapshotLastChangeAt.After(firedFor) {
		// No notify arrived after Desktop's fire decision (or caller
		// didn't pass a snapshot timestamp). Clear dirty cleanly.
		s.autoSnapshotDirty = false
		return
	}
	// A notify landed during the upload window — leave dirty=true
	// so the next due check (after min-interval + new debounce)
	// fires another upload covering those mid-flight edits.
	log.Printf("auto-snapshot: ack preserved dirty (notify during upload window): firedFor=%s lastChangeAt=%s", firedFor.Format(time.RFC3339Nano), s.autoSnapshotLastChangeAt.Format(time.RFC3339Nano))
}

// autoSnapshotDueLocked computes whether Desktop should fire an upload
// right now. s.mu must be held. Three conditions all must hold:
//  1. dirty=true (at least one change since last ack)
//  2. quiet window elapsed (no change in autoSnapshotDebounce)
//  3. min-interval elapsed (no fire in autoSnapshotMinInterval, or
//     no fire yet at all)
func (s *Service) autoSnapshotDueLocked() bool {
	if !s.autoSnapshotDirty {
		return false
	}
	now := s.now()
	if now.Sub(s.autoSnapshotLastChangeAt) < autoSnapshotDebounce {
		return false
	}
	if !s.autoSnapshotLastAckAt.IsZero() && now.Sub(s.autoSnapshotLastAckAt) < autoSnapshotMinInterval {
		return false
	}
	return true
}

// IncomingPreImage returns the bytes of rel as it existed locally just
// before the most recent inbound sync overwrote or deleted it. The
// bool is false when no snapshot exists (no remote sync has touched
// rel since the daemon last bound, or the storage layer is disabled).
// Used by the HTTP handler that backs the VS Code extension's
// kari-before:// FileSystemProvider.
func (s *Service) IncomingPreImage(rel string) ([]byte, bool) {
	s.mu.Lock()
	h := s.incomingHistory
	s.mu.Unlock()
	if h == nil {
		return nil, false
	}
	return h.Get(rel)
}

// ListRemoteSessions returns the past Claude/Codex CLI session lists
// from the trans-server, with a 30s in-memory cache so the extension
// can refresh the TreeView without hammering the wire. Errors when the
// daemon isn't actively connected to a server (caller renders a
// "bind a license first" placeholder), or when the request times out.
func (s *Service) ListRemoteSessions(ctx context.Context, req transport.ListSessionsRequest) (transport.ListSessionsResult, error) {
	now := time.Now()

	s.mu.Lock()
	key := remoteSessionsCacheKeyFor(req, s.status.WorkspaceRoot)
	if !req.ForceRefresh {
		if entry, ok := s.remoteSessionsCache[key]; ok && now.Sub(entry.at) < remoteSessionsCacheTTL {
			s.mu.Unlock()
			return entry.result, nil
		}
	}
	session := s.activeSession
	s.mu.Unlock()
	if session == nil {
		return transport.ListSessionsResult{}, errors.New("daemon not connected to server")
	}

	ch, err := session.RequestListSessions(req)
	if err != nil {
		return transport.ListSessionsResult{}, err
	}
	select {
	case res := <-ch:
		s.mu.Lock()
		if s.remoteSessionsCache == nil {
			s.remoteSessionsCache = map[string]remoteSessionsCacheEntry{}
		}
		s.remoteSessionsCache[key] = remoteSessionsCacheEntry{result: res, at: time.Now()}
		s.mu.Unlock()
		return res, nil
	case <-ctx.Done():
		// Atomic clear-waiter-and-drain-queue. See Session.AbortListSessions
		// doc for why it must be one mu-protected operation: splitting
		// it would race a new caller's enqueue between the two halves.
		session.AbortListSessions()
		return transport.ListSessionsResult{}, ctx.Err()
	case <-time.After(remoteSessionsRequestTimeout):
		// Atomic clear-waiter-and-drain-queue. Without the queue drain,
		// the stale request payload would sit in the size-1
		// listSessionsReq channel forever (sendLoop is typically wedged
		// on its previous stream.Send when this branch fires), and
		// every subsequent RequestListSessions call would return
		// "queue full" — Sessions tab never recovers until session
		// rebuild.
		session.AbortListSessions()
		return transport.ListSessionsResult{}, errors.New("list remote sessions: timeout waiting for server reply")
	}
}

// remoteSessionsCacheKeyFor produces a stable cache key for the
// requested-sources slice. Order-insensitive so ?sources=a,b and
// ?sources=b,a hit the same cache entry.
func remoteSessionsCacheKeyFor(req transport.ListSessionsRequest, workspaceRoot string) string {
	prefix := strings.TrimSpace(workspaceRoot)
	if len(req.Sources) == 0 {
		return prefix + "|*"
	}
	cp := append([]string(nil), req.Sources...)
	sort.Strings(cp)
	return prefix + "|" + strings.Join(cp, ",")
}
