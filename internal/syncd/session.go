package syncd

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/config"
	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// ErrSessionReplaced is returned from runOnce when the trans-server
// preempts us. The reconnect loop catches it and shuts itself down
// instead of looping forever.
var ErrSessionReplaced = errors.New("session replaced by another client")

// ErrRevoked is returned from runOnce when the trans-server's
// license-check supervisor signalled that the workspace has been
// revoked or removed mid-session. Same caller contract as
// ErrSessionReplaced (permanent stop, no reconnect) but distinct so
// the daemon status / UI can show "license revoked" vs "kicked".
//
// TODO(syncthing-lease §P0b): when the Syncthing backend's lease
// state machine lands, runOnce should also call lease.ForceClose on
// this path to pause the local Syncthing folder immediately rather
// than relying purely on the server having already done so. For now
// the receive-side is best-effort signal, not a security boundary;
// safety comes from the server-side cancel and (eventually) the
// server-side lease.ForceClose.
var ErrRevoked = errors.New("session revoked by license server")

// TriggerSync forces a single rescan + send cycle on the live session
// without waiting for the rescan ticker. Replaces the durableQueue
// "write to file, never consume" pattern that made the extension UI
// lie about completion. Two cases:
//   - daemon not running yet: Start() the run loop (caller may have
//     bound just before triggering).
//   - daemon running: non-blocking signal on kickChan; the session's
//     engine.Watch loop picks it up and runs a deep rescan immediately.
//     Coalesced — multiple rapid triggers collapse to one rescan.
func (s *Service) TriggerSync() error {
	s.mu.Lock()
	running := s.running
	kick := s.kickChan
	bound := s.bind
	s.mu.Unlock()
	// L2 sub-commit B: control-only mode means the file plane is
	// inert. Both branches below (Start a new run loop, kick an
	// existing one for deep rescan) would resurrect file-sync work
	// — Start brings up runOnce which would re-construct a Session
	// (control-only would re-apply, but the resync side-effects of
	// "rescan after rebind" still aren't what control-only promises),
	// and the kick wakes engine.Watch which we deliberately did NOT
	// start under control-only. Silent no-op: periodic-rescan callers
	// (internal ticker / fsnotify watchdog) don't surface errors
	// anyway, and HTTP /v1/sync-once routes through CreateSyncTask
	// which has its own typed-error path.
	if isControlOnlyBind(bound) {
		return nil
	}
	if !running {
		return s.Start()
	}
	if kick != nil {
		select {
		case kick <- struct{}{}:
		default:
			// Already pending — that's fine, the receiver will
			// service this trigger when it processes the prior one.
		}
	}
	return nil
}

func (s *Service) runLoop(ctx context.Context) {
	backoff := 1 * time.Second
	for {
		// classifyRunOnceError keeps the loop from surfacing transient
		// cancellations (e.g. server-side supervisor terminating the stream
		// after a license check) as user-visible errors. Those are expected
		// reconnect signals, not failures.
		err := s.runOnce(ctx)
		if errors.Is(err, ErrRevoked) {
			// License revoked / workspace removed. Permanent stop —
			// unlike ErrSessionReplaced this is not someone-else-took-
			// over, it's "you don't have a license to be here". UI
			// distinguishes via Status.Revoked.
			s.markRevoked()
			return
		}
		if errors.Is(err, ErrSessionReplaced) {
			// Permanent kick. Mark status and break the loop so we
			// don't fight a newer client over the same license.
			s.markKicked()
			return
		}
		if err != nil && !errors.Is(err, context.Canceled) {
			s.setError(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			s.bumpReconnect()
			if backoff < 15*time.Second {
				backoff = backoff * 2
			}
		}
	}
}

func (s *Service) runOnce(ctx context.Context) error {
	s.mu.Lock()
	s.ensureExecBridgeLoadedLocked()
	bind := s.bind
	workspaceName := s.workspaceName
	execPolicy := s.execPolicy
	execBasePath := s.execBasePath
	s.mu.Unlock()

	engine, err := filesync.New(bind.WorkspaceRoot, "client-daemon")
	if err != nil {
		return fmt.Errorf("new engine: %w", err)
	}
	// Fresh-download hook (Codex round 9 #2): write a conservative
	// .kariignore default ONLY when the workspace looks like a
	// brand-new cloud-download mirror — detected by the presence of
	// the desktop fresh-download marker at
	// .kari-engine/desktop-download-incomplete. Local projects + any
	// already-completed mirror must NOT silently gain a daemon-
	// authored ignore list, otherwise users who had been uploading
	// dist/build/node_modules deliberately would retroactively stop
	// syncing them.
	//
	// O_EXCL inside WriteDefaultKariIgnoreIfMissing further protects
	// against overwriting an existing file (e.g. user edited their
	// .kariignore between download attempts). Errors logged but
	// do NOT block bind — a daemon that refuses to sync because it
	// couldn't write a default ignore list is a worse UX than
	// running without the optimization.
	if IsFreshDownloadBind(bind.WorkspaceRoot) {
		if wrote, kerr := WriteDefaultKariIgnoreIfMissing(bind.WorkspaceRoot); kerr != nil {
			log.Printf("write default .kariignore: %v (continuing without it)", kerr)
		} else if wrote {
			log.Printf("wrote default .kariignore at %s — user can edit + re-sync to override", bind.WorkspaceRoot)
		}
	}
	// Snapshot pre-images so the VS Code extension can render gutter
	// diff bars on incoming changes. nil-check guards the typed-nil
	// trap (passing a nil *IncomingHistory through the interface
	// parameter would still be a non-nil interface that panics on
	// method call).
	if s.incomingHistory != nil {
		engine.SetIncomingHistoryStore(s.incomingHistory)
	}

	keyB64 := config.SharedKeyFromActivationCode(bind.ActivationCode)
	key, err := config.DecodeSharedKey(keyB64)
	if err != nil {
		return fmt.Errorf("decode activation key: %w", err)
	}

	cc, err := transport.Dial(ctx, bind.ServerAddr)
	if err != nil {
		return fmt.Errorf("dial server: %w", err)
	}
	defer cc.Close()

	client := transport.NewClient(cc)
	rawStream, err := client.Sync(ctx)
	if err != nil {
		return fmt.Errorf("open sync stream: %w", err)
	}
	stream, err := transport.NewSecureSyncClient(rawStream, key, bind.WorkspaceID)
	if err != nil {
		return fmt.Errorf("secure sync stream: %w", err)
	}

	// Buffered=1 so TriggerSync's non-blocking send always succeeds;
	// coalescing multiple triggers into one rescan is the right
	// behaviour anyway.
	kick := make(chan struct{}, 1)
	s.mu.Lock()
	s.kickChan = kick
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.kickChan == kick {
			s.kickChan = nil
		}
		s.mu.Unlock()
	}()

	// setConnected(true) deferred to the handshake-ack hook below — firing
	// it here would lie to the UI on every transient EOF, because
	// transport.Dial uses grpc.NewClient (lazy) and the actual TCP
	// connect doesn't happen until session.Run sends its first hello.
	session := filesync.NewSession(engine, stream)
	session.SetRemoteActivityHook(s.noteRemoteActivity)
	session.SetActivityHook(s.markActive)
	session.SetManifestHook(s.markManifestExchanged)
	session.SetPeerManifestHook(s.recordPeerManifest)
	session.SetBootstrapResultHook(s.recordBootstrapResult)
	session.SetPtyCountUpdateHook(s.recordPtyCountUpdate)
	session.SetWorkspaceName(workspaceName)
	session.SetClientID(bind.ClientID)
	session.SetHandshakeAckHook(func() { s.setConnected(true) })
	// Cross-reconnect cancel persistence (Codex round 6 blocking).
	// If the user had previously cancelled the download for this
	// workspace AND has not yet retried, mark the new session to
	// start in stopped state so it neither sends the initial
	// MessageManifest nor lets the peer push anything until the
	// next CreateSyncTask (retry) clears pausedDownloads and queues
	// a Resume.
	if s.isDownloadPaused(workspaceName) {
		session.SetStartPaused(true)
	}
	// Disable the empty-remote pause guard for snapshot staging binds.
	// Staging dirs are fresh-by-design and the whole point of the snapshot
	// upload pipeline is to push the first content into an empty remote.
	// Without this, applyManifestPause sees remote=0 + local=N and pauses
	// outbound — sync_task then "succeeds" with bytes from incidental
	// .kari/ download traffic but the 88 project files we wanted to push
	// never reach the server-side staging dir.
	if isStagingBindKind(bind.BindKind) {
		session.SetDisablePauseGuard(true)
		// L2 sub-commit C: staging sessions are one-shot push/pull
		// channels — never propagate outbound deletes regardless of
		// trigger (fsnotify cleanup of local staging dir, DiffManifest
		// vs pre-existing peer tombstones, peer-status retry).
		// Production wipe pattern this closes: upload-staging
		// succeeds → Desktop cleans local staging dir → daemon
		// watcher fires 89 file-deletes → daemon pushes 89
		// MessageDelete to server → server wipes the just-materialized
		// workspace. See controlOnly contract for the workspace-bind
		// half of the wipe surface.
		session.SetSuppressOutboundDeletes(true)
		log.Printf("runOnce: staging bind kind=%q ws=%q → outbound deletes suppressed", bind.BindKind, workspaceName)
	}
	// L2 sub-commit B: syncthing-backed workspace bind without staging_id
	// runs the session in control-only mode. PTY / LocalExec / Bootstrap /
	// ListSessions still flow through. The filesync outbound plane is
	// suppressed (initial manifest send, Watch rescans, DiffManifest
	// enqueue), while inbound cloud->local file/delete/textop writes are
	// still accepted as server-authoritative. This prevents the production
	// wipe where legacy bidirectional sync diffed against an empty/staging-
	// marker working tree and emitted toDelete=N to the server post-
	// snapshot-commit without breaking server->local updates.
	// Set BEFORE session.Run starts (filesync.Session captures the flag
	// once at Run entry for Watch / fallback decisions). See
	// isControlOnlyBind in service.go for the centralized predicate.
	if isControlOnlyBind(bind) {
		session.SetControlOnly(true)
		log.Printf("runOnce: syncthing workspace bind (staging_id empty) ws=%q → control-only mode (outbound suppressed, inbound allowed)", workspaceName)
	}
	// Wire the local-exec MCP bridge runner if the platform supports
	// cancellation cleanly and a policy loader was set up. The runner
	// is per-session because it captures workspace_id and root for
	// audit + cwd validation; reconnects build a fresh one. Installing
	// the handler also flips Hello to advertise CapabilityLocalExec so
	// the server's RouteLocalExec can find this daemon by (wsid, clientID).
	if execPolicy != nil {
		runner := NewLocalExecRunner(LocalExecRunnerConfig{
			Loader:    execPolicy,
			BasePath:  execBasePath,
			AuditPath: LocalExecAuditPath(),
		}, bind.WorkspaceID, bind.WorkspaceRoot)
		if runner != nil {
			session.SetLocalExecHandler(runner.Handle)
		}
	}
	// Publish session so /v1/bootstrap can queue a request onto it.
	s.mu.Lock()
	s.activeSession = session
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.activeSession == session {
			s.activeSession = nil
			s.failPendingBootstrapLocked("connection_lost", "sync session ended before server returned bootstrap result; retry after reconnect")
		}
		s.mu.Unlock()
	}()
	err = session.Run(ctx, time.Duration(bind.RescanSeconds)*time.Second, kick)
	s.setConnected(false)

	if errors.Is(err, transport.ErrRevoked) {
		// Permanent stop: the server's license-check supervisor told
		// us the workspace has been revoked. Surface a distinct local
		// error so runLoop can mark Status.Revoked and the UI shows
		// "license revoked" instead of "kicked".
		return ErrRevoked
	}
	if errors.Is(err, transport.ErrSessionReplaced) {
		// Permanent stop: don't loop trying to reconnect, we'd just
		// get kicked again by whoever is now using this license.
		return ErrSessionReplaced
	}
	switch classifyRunOnceError(err) {
	case runOnceOutcomeOK:
		s.markSynced()
		return nil
	case runOnceOutcomeCanceled:
		// Expected reconnect signal. Leave LastError untouched and let
		// runLoop sleep through the backoff instead of flashing a red
		// "context canceled" error on the sidebar.
		return nil
	default:
		return fmt.Errorf("sync session ended: %w", err)
	}
}

type runOnceOutcome int

const (
	runOnceOutcomeOK runOnceOutcome = iota
	runOnceOutcomeCanceled
	runOnceOutcomeError
)

// classifyRunOnceError partitions session.Run's exit reasons into three
// buckets so runOnce/runLoop can decide whether to mark synced, silently
// reconnect, or surface a real error to the UI. Pure function on purpose
// so it stays trivial to unit-test.
func classifyRunOnceError(err error) runOnceOutcome {
	if err == nil {
		return runOnceOutcomeOK
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return runOnceOutcomeCanceled
	}
	return runOnceOutcomeError
}
