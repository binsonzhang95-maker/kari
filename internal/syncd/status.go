package syncd

import (
	"sort"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

type Status struct {
	Connected      bool      `json:"connected"`
	Running        bool      `json:"running"`
	LastError      string    `json:"last_error,omitempty"`
	WorkspaceRoot  string    `json:"workspace_root,omitempty"`
	ServerAddr     string    `json:"server_addr,omitempty"`
	WorkspaceID    string    `json:"workspace_id,omitempty"`
	LastSyncAt     time.Time `json:"last_sync_at,omitempty"`
	ReconnectCount int       `json:"reconnect_count"`
	// LastActivityAt advances every time the live session sends or
	// applies a real file (heartbeats don't count). Extension uses
	// it to tell "TriggerSync did something" from "nothing changed
	// since I clicked." Zero on a freshly bound daemon.
	LastActivityAt time.Time `json:"last_activity_at,omitempty"`
	// ManifestExchangedAt advances once per session when the peer's
	// manifest arrives (or, symmetrically, when we receive theirs).
	// Distinct from LastActivityAt: a manifest exchange that finds
	// nothing to do still bumps this but not the activity timestamp.
	ManifestExchangedAt time.Time `json:"manifest_exchanged_at,omitempty"`
	// PeerManifestFiles is the number of entries (files + tombstones)
	// in the peer's most recent manifest. 0 means the peer's workspace
	// is completely empty — the workbench shows a guided bootstrap /
	// initial-sync choice to fill it. Updated on each manifest exchange.
	PeerManifestFiles int `json:"peer_manifest_files"`
	// PeerRepoURL is the git remote origin URL reported by the peer's
	// repo-lock file. Empty if the peer hasn't been bootstrapped yet.
	PeerRepoURL string `json:"peer_repo_url,omitempty"`
	// LocalRepoURL is the git remote origin URL of the local workspace.
	// Empty if there's no git repo here yet.
	LocalRepoURL string `json:"local_repo_url,omitempty"`
	// UploadsPaused reports that the session has stopped pushing local
	// files to the peer because of an emptiness or repo-identity guard.
	// Receive direction continues normally. The workbench surfaces
	// PauseReason to explain why so the user can run /v1/bootstrap or
	// fix their workspace.
	UploadsPaused bool   `json:"uploads_paused,omitempty"`
	PauseReason   string `json:"pause_reason,omitempty"`
	// LastBootstrap holds the most recent server-side git clone
	// result. Empty until the operator triggers /v1/bootstrap once.
	LastBootstrap      BootstrapState             `json:"last_bootstrap,omitempty"`
	RemoteEditingPaths []string                   `json:"remote_editing_paths,omitempty"`
	PendingOutbound    int                        `json:"pending_outbound,omitempty"`
	PtyCount           int                        `json:"pty_count"`
	SyncCounters       *filesync.EngineCounters   `json:"sync_counters,omitempty"`
	ForceAllowEntries  []filesync.ForceAllowEntry `json:"force_allow_entries,omitempty"`
	// Kicked = true when the trans-server replied with a
	// session_replaced envelope (a newer client connected with the
	// same workspace_id). When set, the daemon will NOT auto-reconnect
	// until the user re-binds; surfacing this avoids the silent ping-
	// pong of two laptops fighting over the same key.
	Kicked bool `json:"kicked,omitempty"`
	// Revoked = true when the trans-server's license-check supervisor
	// signalled the workspace has been revoked or removed mid-session
	// (ReasonRevoked / lease plan §P0b). Distinct from Kicked so the
	// UI can show "license revoked / contact admin" rather than
	// "kicked by another device". Daemon will NOT auto-reconnect; the
	// operator must resolve the license issue and rebind.
	Revoked bool `json:"revoked,omitempty"`
	// Auto-snapshot Phase 1 surface. Desktop polls /v1/status; when
	// AutoSnapshotDue flips true, Desktop fires the Upload pipeline.
	// AutoSnapshotDirty/LastChangeAt/LastAckAt are informational —
	// helpful for log/observability ("daemon saw 3 changes since
	// last ack; quiet window started at T").
	AutoSnapshotDirty        bool      `json:"auto_snapshot_dirty,omitempty"`
	AutoSnapshotDue          bool      `json:"auto_snapshot_due,omitempty"`
	AutoSnapshotLastChangeAt time.Time `json:"auto_snapshot_last_change_at,omitempty"`
	AutoSnapshotLastAckAt    time.Time `json:"auto_snapshot_last_ack_at,omitempty"`
}

const remoteEditingTTL = 6 * time.Second

func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneRemoteActivityLocked(time.Now())
	st := s.status
	if s.activeSession != nil {
		st.PendingOutbound = s.activeSession.PendingOutboundSize()
		counters := s.activeSession.EngineCounters()
		st.SyncCounters = &counters
		st.UploadsPaused = s.activeSession.UploadsPaused()
		st.PauseReason = s.activeSession.PauseReason()
		st.ForceAllowEntries = s.activeSession.ForceAllowEntries()
	}
	if len(st.RemoteEditingPaths) > 0 {
		st.RemoteEditingPaths = append([]string(nil), st.RemoteEditingPaths...)
	}
	// Auto-snapshot Phase 1 reflection.
	st.AutoSnapshotDirty = s.autoSnapshotDirty
	st.AutoSnapshotLastChangeAt = s.autoSnapshotLastChangeAt
	st.AutoSnapshotLastAckAt = s.autoSnapshotLastAckAt
	st.AutoSnapshotDue = s.autoSnapshotDueLocked()
	return st
}

func (s *Service) markKicked() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	s.status.Running = false
	s.status.Connected = false
	s.status.Kicked = true
	s.status.LastError = "session replaced by another client"
}

// revokedLastErrorMessage is the canonical Status.LastError text for
// the ReasonRevoked path. Centralised so markRevoked() and the
// terminal-status reset in clearTerminalStatusLocked stay in sync.
//
// Wording covers both server-side cases that the supervise() branch
// maps to ReasonRevoked: a disabled key and a deleted workspace.
// MessageError.Data
// will get a granular reason later; v1 keeps a single user-facing
// string so the UI doesn't show a confusing "license revoked" for a
// workspace that was actually removed.
const revokedLastErrorMessage = "license revoked or workspace removed"

// markRevoked is the parallel of markKicked for the
// ReasonRevoked / license-revoked-mid-session path. Same lifecycle
// effect (no auto-reconnect, daemon stops driving sync) but distinct
// status field so the UI can render a different message.
//
// TODO(syncthing-lease §P0b): once the Syncthing backend's lease
// state machine lands here, this is where we'd also invoke
// lease.ForceClose("revoked") and ensure the local Syncthing folder
// is paused. At that point the server-side will also be doing
// pause+remove on its end (per lease §P0b), making this a defense-
// in-depth client-side action. Today neither side has the data-plane
// pause yet; the filesync path treats this as a UX signal only.
func (s *Service) markRevoked() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	s.status.Running = false
	s.status.Connected = false
	s.status.Revoked = true
	s.status.LastError = revokedLastErrorMessage
}

// clearTerminalStatusLocked clears the "permanent stop" flags that
// markKicked() / markRevoked() set, plus the matching LastError
// strings. Called from Bind() when the operator explicitly re-attaches
// — that's the signal that whatever stopped us has been resolved.
//
// Caller MUST hold s.mu. Extracted as a helper so Bind() and tests
// share the exact reset surface; otherwise a future refactor of Bind()
// could silently stop clearing one of these flags and tests that
// merely simulate the reset wouldn't catch it.
func (s *Service) clearTerminalStatusLocked() {
	s.status.Kicked = false
	s.status.Revoked = false
	switch s.status.LastError {
	case "session replaced by another client", revokedLastErrorMessage:
		s.status.LastError = ""
	}
}

func (s *Service) setConnected(ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Connected = ok
	if !ok {
		s.remoteActivityAt = map[string]time.Time{}
		s.status.RemoteEditingPaths = nil
	}
}

func (s *Service) markSynced() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.LastSyncAt = time.Now()
	s.status.LastError = ""
}

// markActive bumps LastActivityAt whenever the live session has just
// moved real bytes (sent a file, applied a file, applied a delete).
// LastSyncAt is reserved for the session-cleanly-exited milestone -
// for long-lived streams that almost never happens, so the extension
// needs a "did anything actually move?" signal. Heartbeats don't call
// this hook by design.
func (s *Service) markActive() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.LastActivityAt = time.Now()
}

// markManifestExchanged fires when Session sees the peer's manifest.
// Lets the extension distinguish "manifest reconciled, both sides
// converged with nothing to push" from "still scanning" - without
// this, a workspace where every file is already in sync would never
// advance LastActivityAt and the UI couldn't ever say "完成".
func (s *Service) markManifestExchanged() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.ManifestExchangedAt = time.Now()
}

// recordPeerManifest is called each time the session receives the peer's
// manifest. n is the total number of entries (live files + tombstones)
// the peer reported; repoURL is the peer's best-known git identity.
func (s *Service) recordPeerManifest(n int, repoURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.PeerManifestFiles = n
	if repoURL != "" {
		s.status.PeerRepoURL = repoURL
	}
}

func (s *Service) recordPtyCountUpdate(update transport.PtyCountUpdate) {
	if update.PtyCount < 0 {
		update.PtyCount = 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ptyCounts == nil {
		s.ptyCounts = map[string]int{}
	}
	if update.WorkspaceID != "" {
		s.ptyCounts[update.WorkspaceID] = update.PtyCount
	}
	if update.WorkspaceID == "" || update.WorkspaceID == s.status.WorkspaceID {
		s.status.PtyCount = update.PtyCount
	}
}

func (s *Service) setError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.LastError = err.Error()
}

func (s *Service) bumpReconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.ReconnectCount++
}

func (s *Service) noteRemoteActivity(path string) {
	if path == "" {
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneRemoteActivityLocked(now)
	s.remoteActivityAt[path] = now
	s.syncRemoteEditingPathsLocked(now)
}

func (s *Service) pruneRemoteActivityLocked(now time.Time) {
	changed := false
	for p, ts := range s.remoteActivityAt {
		if now.Sub(ts) > remoteEditingTTL {
			delete(s.remoteActivityAt, p)
			changed = true
		}
	}
	if changed {
		s.syncRemoteEditingPathsLocked(now)
	}
}

func (s *Service) syncRemoteEditingPathsLocked(now time.Time) {
	paths := make([]string, 0, len(s.remoteActivityAt))
	for p, ts := range s.remoteActivityAt {
		if now.Sub(ts) <= remoteEditingTTL {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	if len(paths) == 0 {
		s.status.RemoteEditingPaths = nil
		return
	}
	s.status.RemoteEditingPaths = paths
}
