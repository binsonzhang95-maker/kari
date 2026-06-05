package syncthing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Sidecar is the public lifecycle interface for a Kari-managed
// Syncthing sidecar process — per migration plan §3.7 D1 (child
// process spawn + supervise) + D9 (refined API).
//
// Method contracts:
//   - Start is idempotent: returns nil if the sidecar is already
//     running. Otherwise: orphan-check the previous pidfile →
//     pre-pick port → write config.xml (gui-block RMW preserving
//     unknown elements) → exec syncthing (1 retry on cmd.Start
//     failure per §3.7 D9 (c)) → write pidfile → poll
//     /rest/noauth/health until 200 (10s timeout).
//   - Stop is idempotent: returns nil if not running. Otherwise:
//     SIGTERM → 5s grace → SIGKILL → bounded 2s reap → return.
//     Windows degrades to immediate Kill (Job Object containment
//     is a follow-up). On clean reap: removes the pidfile and
//     surfaces removal errors via wrapped return error so callers
//     know if a stale marker may block next Start.
//   - Status returns a snapshot read; safe for concurrent callers.
//     Callers MUST treat (!Running || Stuck) as no-usable-sidecar.
//   - Client returns the RestClient bound to this sidecar's
//     endpoint + API key. Returns nil before first successful Start.
//
// What PR1.3b-2 implements (steps 1+2+3, all complete):
//   - happy-path lifecycle (Start / Stop / Status / Client)
//   - pidfile + cmdline-hash marker + orphan-check at Start
//     (HARD cross-platform recovery mechanism per §3.7 D9 (b))
//   - config.xml gui-block RMW preserving syncthing-accreted state
//     across restarts (§3.7 D9 (c))
//   - per-OS parent-death best-effort: Linux Pdeathsig, macOS
//     no-op, Windows no-op + TODO Job Object (§3.7 D9 (d))
//   - tri-state probeProcess (gone / alive / unknown — fail-closed
//     on EPERM / ERROR_ACCESS_DENIED ambiguity)
//   - Stuck state for un-confirmed-reap Stop windows (Start
//     refuses while Stuck; drain goroutine auto-clears)
//
// Explicitly NOT in PR1.3b-2 — handled by follow-up PRs:
//   - main wiring / mgmt readiness flip (PR1.3b-4)
//   - cold-safety scrub + startup-rebuild (PR1.3b-3)
//   - crash watch + auto-restart loop (TBD)
type Sidecar interface {
	Start(ctx context.Context, opts StartOptions) error
	Stop(ctx context.Context) error
	Status() SidecarStatus
	Client() *RestClient
}

// StartOptions configures a single Start call. PR1.3b-2 step 1 keeps
// it minimal — step 3 / 4 will grow it with per-platform spawn
// flags, custom log sinks, etc., as those concerns surface.
type StartOptions struct {
	// HomeDir is the Syncthing state directory (per §3.7 D3:
	// server-side <sync_dir>/.syncthing-home/, client-side
	// ~/.kari/syncthing/<folder_id>/home/). MUST exist + be 0700
	// owner-only — callers enforce this before invoking Start.
	HomeDir string

	// Binary is the absolute path to the syncthing executable. PR1.3b-2
	// callers pass the full path; D2's "adjacent-to-self or PATH"
	// lookup logic lives in the main-wiring PR (1.3b-4), not here.
	Binary string

	// DataListenAddress, when set, pins the Syncthing BEP (data) listen
	// address verbatim — e.g. "tcp://0.0.0.0:22000" so remote clients can
	// reach this sidecar on a fixed, externally-routable port. Empty (the
	// default) keeps the original behaviour: a freshly pre-picked
	// loopback-only ephemeral port (tcp://127.0.0.1:<free>), which only
	// works when the peer reaches Syncthing through a tunnel/proxy. The
	// single-tenant OSS server has no tunnel, so it sets this to bind all
	// interfaces on the advertised port.
	DataListenAddress string
}

// SidecarStatus is the snapshot read returned by Status(). Field
// values are point-in-time — concurrent state changes after the read
// are not reflected. Callers wanting "live" tracking subscribe via
// future hooks (out of PR1.3b-2 scope).
type SidecarStatus struct {
	Running bool

	// Stuck is true when a previous Stop attempt could not confirm
	// the child process was reaped within its bounded wait windows
	// (SIGKILL → 2s, or ctx cancel → 100ms drain). The PID may
	// still reference a process that exists at the OS layer, may
	// be a zombie not yet collected, or may already be gone with a
	// stale Wait pending. Start REFUSES while Stuck is true to
	// avoid spawning a second process against the same HomeDir.
	//
	// Stuck auto-clears: Stop's drain goroutine continues to
	// receive on the Wait channel after Stop returns, and once
	// Wait yields, the goroutine takes the mutex and flips
	// Stuck=false. So the unreaped window is bounded by however
	// long the kernel actually takes to finalise — typically
	// milliseconds. Operators who want an explicit recovery path
	// will get it via step 2's pidfile-based orphan cleanup on
	// next Start.
	Stuck bool

	PID          int
	StartedAt    time.Time
	LastExitErr  error
	RestartCount int

	// BEPAddress is the loopback-only Syncthing BEP listen address
	// for this sidecar (host:port, no scheme). ConsoleZ's public
	// SOCKS5 mux dials this address after authenticating a Desktop
	// Syncthing connection. Empty unless Running is true.
	BEPAddress string
}

// SidecarManager is the production implementation of Sidecar.
// Safe for concurrent use via mu; Start and Stop serialize against
// each other, Status / Client take the mutex briefly for snapshot.
type SidecarManager struct {
	mu  sync.Mutex
	cmd *exec.Cmd // nil before first successful Start AND after Stop

	state SidecarStatus

	// homeDir stashed at Start time so Stop knows which pidfile
	// (and which Sidecar HomeDir) to operate against without
	// requiring callers to thread StartOptions back into Stop.
	// Cleared on clean Stop.
	homeDir string
	apiKey  string
	port    int
	bepPort int
	client  *RestClient
}

// NewSidecarManager constructs an idle SidecarManager. Lifecycle
// starts on first Start; until then Status().Running == false and
// Client() == nil.
func NewSidecarManager() *SidecarManager {
	return &SidecarManager{}
}

// Compile-time assertion that SidecarManager satisfies Sidecar.
var _ Sidecar = (*SidecarManager)(nil)

// Start implements the Sidecar contract — see interface docs.
//
// On error, partial state is rolled back: if exec.Cmd.Start succeeds
// but the health poll fails, the spawned process is killed and
// Wait()'d before returning so no orphan is left behind. The error
// path NEVER leaves SidecarManager.state.Running == true.
func (m *SidecarManager) Start(ctx context.Context, opts StartOptions) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.state.Running {
		return nil // idempotent
	}
	// Round-1 review High fix: refuse to start while a previous
	// Stop's reap is still outstanding. Spawning a second process
	// against the same HomeDir / config.xml while the first isn't
	// confirmed dead could double-bind the GUI port (collision),
	// race on syncthing's keyfile generation, or simply produce a
	// confusing "two syncthings, one workspace" state. The drain
	// goroutine in markStuck will auto-clear once the original
	// Wait completes; step 2's pidfile orphan-check will provide
	// an explicit recovery path for the pathological case.
	if m.state.Stuck {
		return fmt.Errorf("syncthing sidecar: previous Stop did not confirm process reap (last pid=%d, last err=%v); refusing Start until reap completes", m.state.PID, m.state.LastExitErr)
	}
	if opts.HomeDir == "" {
		return errors.New("syncthing sidecar: StartOptions.HomeDir required")
	}
	if opts.Binary == "" {
		return errors.New("syncthing sidecar: StartOptions.Binary required")
	}

	// Argv we'll spawn with — captured early because the orphan-
	// check (step 2) needs its hash to disambiguate PID reuse before
	// we actually exec. cmd is constructed later with the same args.
	argv := []string{opts.Binary,
		"-no-browser",
		"-home", opts.HomeDir,
	}
	cmdHash := hashCmdline(argv)

	// (1) Orphan check (step 2 / §3.7 D9 (b)). Read any prior
	// pidfile; if the recorded PID is still alive AND its cmdline
	// hash matches what we're about to spawn, it's a leak from a
	// previous Sidecar run that died ungracefully — SIGTERM 5s +
	// SIGKILL 2s. If we can't kill it within the budget, refuse to
	// proceed (caller gets a permanent-blocked condition per §4.5
	// Option A / D5 step 4).
	if err := checkOrphanOnStart(opts.HomeDir, cmdHash); err != nil {
		return fmt.Errorf("syncthing sidecar: %w", err)
	}

	// (2) Generate ephemeral API key once. Per §3.7 D3, never
	// written to disk — passed only via STGUIAPIKEY env at exec
	// time. The retry loop below re-pre-picks port + re-writes
	// config.xml but keeps the same apiKey across attempts (the
	// child sees one consistent key).
	apiKey, err := generateAPIKey()
	if err != nil {
		return fmt.Errorf("syncthing sidecar: generate API key: %w", err)
	}

	// (3-5) Pre-pick port → write config.xml → spawn. Per §3.7
	// D9 (c): if cmd.Start fails, retry ONCE with a fresh port
	// (the previous pre-picked port may have been claimed by
	// another process between Close and exec, or some transient
	// fork/exec condition — EAGAIN, ENOMEM — may have cleared).
	// Second failure → return; permanent error.
	//
	// HomeDir is NOT cleaned between attempts (may contain device
	// identity / db / index worth preserving). pidfile is NOT
	// written until after cmd.Start succeeds, so retry doesn't
	// stomp a marker.
	var (
		cmd        *exec.Cmd
		port       int
		bepPort    int
		listenAddr string
		spawnErr   error
		lastPort   int
		lastBEP    int
		attempted  int
	)
	for attempted = 0; attempted < 2; attempted++ {
		port, bepPort, err = prePickSidecarPorts()
		if err != nil {
			return fmt.Errorf("syncthing sidecar: pre-pick ports (attempt %d): %w", attempted+1, err)
		}
		// Data (BEP) listen address: default to the pre-picked loopback-only
		// ephemeral port; the OSS server overrides this with a fixed,
		// externally-routable address (e.g. tcp://0.0.0.0:22000).
		listenAddr = fmt.Sprintf("tcp://127.0.0.1:%d", bepPort)
		if opts.DataListenAddress != "" {
			listenAddr = opts.DataListenAddress
		}
		if err := ensureConfigXML(opts.HomeDir, port, listenAddr); err != nil {
			return fmt.Errorf("syncthing sidecar: ensure config.xml (attempt %d): %w", attempted+1, err)
		}
		cmd = exec.Command(argv[0], argv[1:]...)
		cmd.Env = append(cmd.Environ(),
			"STGUIAPIKEY="+apiKey,
			"STNOUPGRADE=1",
		)
		// Step 3 / §3.7 D9 (d): best-effort per-OS parent-death.
		//   Linux  → SysProcAttr.Pdeathsig = SIGKILL (thread-level
		//            semantic; pidfile orphan-check is the HARD
		//            fallback).
		//   Darwin → no-op (no kernel equivalent).
		//   Windows → no-op + TODO for Job Object.
		applyPdeath(cmd)
		spawnErr = cmd.Start()
		if spawnErr == nil {
			break
		}
		lastPort = port
		lastBEP = bepPort
	}
	if spawnErr != nil {
		return fmt.Errorf("syncthing sidecar: exec failed after %d attempt(s) (last gui port=%d, last bep port=%d): %w", attempted, lastPort, lastBEP, spawnErr)
	}

	// (6) Write pidfile BEFORE polling health. Per §3.7 D9 (b): if
	// the spawned process dies during the health-poll window, the
	// next Start's orphan-check needs to find a marker pointing at
	// the (likely-dead) PID so it can clean up.
	if err := writePidfile(opts.HomeDir, pidfileEntry{PID: cmd.Process.Pid, CmdlineHash: cmdHash}); err != nil {
		// Couldn't write pidfile — kill the spawn we just made and
		// surface the error. Leaving the process alive without a
		// pidfile would create an orphan-resistant zombie.
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return fmt.Errorf("syncthing sidecar: write pidfile: %w", err)
	}

	// (7) Construct RestClient bound to picked port + key. Built
	// here so the health poll can use the same client the caller
	// will get from Client().
	client := NewRestClient(fmt.Sprintf("http://127.0.0.1:%d", port), apiKey)

	// (8) Poll /rest/noauth/health until 200 OK (10s overall). On
	// timeout / context cancel: kill the spawned process, Wait()
	// to reap, remove the pidfile (per D9 (c) "失败 spawn 不留
	// marker"), return error. NEVER return success with a
	// half-started process.
	pollCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pollHealthReady(pollCtx, client); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait() // reap to prevent zombie
		// Round-1 review High fix: D9 (c) requires the pidfile be
		// REMOVED on health-poll failure ("这次 spawn 是失败的，不
		// 留 marker"). Pre-fix code left it in place hoping the
		// next Start's orphan-check would treat it as stale —
		// works in the easy case but creates a window where, if
		// PID reuse + hash mismatch hits before next Start, the
		// fail-closed hash-mismatch path stops Start until an
		// operator manually clears the marker. Since cmd.Wait()
		// just returned (process confirmed reaped), we can safely
		// remove the marker ourselves.
		_ = removePidfile(opts.HomeDir)
		return fmt.Errorf("syncthing sidecar: health poll: %w", err)
	}

	// (9) Stash success state.
	m.cmd = cmd
	m.homeDir = opts.HomeDir
	m.apiKey = apiKey
	m.port = port
	m.bepPort = bepPort
	m.client = client
	m.state.Running = true
	m.state.PID = cmd.Process.Pid
	m.state.StartedAt = time.Now()
	m.state.RestartCount++
	// Report the address peers actually reach us on: the pinned
	// DataListenAddress when set, else the pre-picked loopback port.
	m.state.BEPAddress = strings.TrimPrefix(listenAddr, "tcp://")
	// LastExitErr from previous run (if any) intentionally preserved
	// for diagnostics.
	return nil
}

// Stop implements the Sidecar contract — see interface docs.
//
// SIGTERM → 5s grace → SIGKILL → 2s reap. On Windows
// Process.Signal(SIGTERM) returns an error (signals aren't
// cross-process there), so we fall through immediately to Kill —
// step 3 will add proper Job Object handling for Windows.
//
// Round-1 review High fix: bound every Wait stage. Pre-fix Stop
// would call <-done after Kill() with no timeout, so an exotic
// reap hang (kernel state weirdness / zombie not yet collected)
// would block Stop forever. Each stage now has an explicit cap;
// ctx.Done is honored throughout so a caller cancelling Stop can
// abandon the wait.
//
// Pidfile (step 2 / §3.7 D9 (b)): removed only on confirmed reap.
// Stuck paths INTENTIONALLY leave the pidfile so the next Start's
// orphan-check can pick up cleanup.
func (m *SidecarManager) Stop(ctx context.Context) error {
	m.mu.Lock()
	cmd := m.cmd
	homeDir := m.homeDir
	if !m.state.Running || cmd == nil {
		m.mu.Unlock()
		return nil // idempotent
	}
	m.mu.Unlock()

	// SIGTERM (Unix). Errors on Windows — fall through to Kill.
	sigErr := cmd.Process.Signal(syscall.SIGTERM)

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var waitErr error

	// Stage 1: SIGTERM grace, up to 5s. Skipped on Windows.
	graceful := false
	if sigErr == nil {
		select {
		case waitErr = <-done:
			graceful = true
		case <-time.After(5 * time.Second):
			// grace expired — fall through to SIGKILL.
		case <-ctx.Done():
			// caller cancelled mid-grace — escalate immediately.
		}
	}

	// Stage 2: SIGKILL + bounded reap. Only enter if Stage 1 didn't
	// reap the process gracefully.
	reaped := graceful
	if !graceful {
		_ = cmd.Process.Kill()
		select {
		case waitErr = <-done:
			reaped = true
		case <-time.After(2 * time.Second):
			// D9 says SIGKILL → 2s. Beyond that the process is
			// stuck from our POV — mark and return; the drain
			// goroutine in markStuck keeps receiving on done so
			// state auto-clears when reap eventually completes.
			waitErr = fmt.Errorf("syncthing sidecar: process did not exit within 2s after SIGKILL (pid=%d)", cmd.Process.Pid)
		case <-ctx.Done():
			// Caller abandoned the wait. Drain very briefly in
			// case the reap is about to complete, then bail.
			select {
			case waitErr = <-done:
				reaped = true
			case <-time.After(100 * time.Millisecond):
				waitErr = ctx.Err()
			}
		}
	}

	// Round-1 review High fix: only mark cleanly stopped when Wait
	// actually returned. The pre-fix code unconditionally cleared
	// Running/PID/cmd in the timeout/cancel paths, opening a window
	// where a follow-up Start would spawn a SECOND process while
	// the first was still alive (kernel hadn't reaped). On the
	// unreaped path we call markStuck, which sets Stuck=true (Start
	// refuses) and arranges for the drain goroutine to auto-clear
	// once Wait eventually returns.
	if reaped {
		// Clean stop: remove pidfile so the next Start sees no
		// prior owner. removePidfile is no-op-on-missing, so a
		// double Stop or a Start that already removed it via
		// orphan-check is safe.
		//
		// Round-1 review Medium fix: surface removePidfile failures
		// to the caller. Pre-fix swallowed them with `_ =`, which
		// meant a clean-reap'd Stop could return nil while leaving
		// a stale marker that would block the NEXT Start via the
		// fail-closed hash-mismatch path. We still update in-memory
		// state (Running=false etc.) because the process IS gone —
		// only the marker write failed — so callers polling
		// Status see truth. But we return a wrapped error so they
		// know operator action may be needed before the next Start.
		rmErr := removePidfile(homeDir)

		m.mu.Lock()
		m.state.Running = false
		m.state.Stuck = false
		m.state.PID = 0
		m.state.LastExitErr = waitErr // typically *exec.ExitError after a signal
		m.state.BEPAddress = ""
		m.cmd = nil
		m.homeDir = ""
		m.bepPort = 0
		m.mu.Unlock()

		if rmErr != nil {
			return fmt.Errorf("syncthing sidecar: stop reaped child cleanly but pidfile removal failed (next Start may be blocked until operator clears %s/%s): %w", homeDir, pidfileName, rmErr)
		}
		return nil
	}
	// Stuck path: INTENTIONALLY leave the pidfile in place. Next
	// Start's orphan-check will see it, probe, and either kill the
	// real orphan (cmdline-hash match) or remove the stale marker
	// (PID reused / process gone).
	m.markStuck(waitErr, done)
	return waitErr
}

// markStuck transitions state to the unreaped-but-attempted-stop
// shape: Running=false, Stuck=true, cmd reference cleared.
// PID is RETAINED for diagnostic visibility (operator can see which
// PID is in limbo). LastExitErr carries the reason Stop bailed
// (SIGKILL+2s timeout / ctx cancel) until the drain goroutine
// overwrites it with the actual exit when Wait eventually returns.
//
// The drain goroutine outlives Stop. It blocks on done and, when
// Wait yields, clears Stuck under the mutex so a subsequent Start
// can proceed. This means transient OS-level reap delays self-heal;
// only a genuinely-stuck zombie keeps Stuck=true indefinitely (the
// pathological case where step 2's pidfile cleanup eventually
// recovers).
func (m *SidecarManager) markStuck(initialErr error, done <-chan error) {
	m.mu.Lock()
	m.state.Running = false
	m.state.Stuck = true
	m.state.LastExitErr = initialErr
	m.state.BEPAddress = ""
	// Keep PID for diagnostics; clear cmd so Status / Client don't
	// expose a dangling reference.
	m.cmd = nil
	m.mu.Unlock()

	go func() {
		err, ok := <-done
		m.mu.Lock()
		defer m.mu.Unlock()
		// Only auto-clear if state is still Stuck (no parallel API
		// has reset it via some future explicit recovery path).
		if m.state.Stuck {
			m.state.Stuck = false
			m.state.PID = 0
			m.state.BEPAddress = ""
			if ok {
				m.state.LastExitErr = err
			}
		}
	}()
}

// Status implements the Sidecar contract — see interface docs.
func (m *SidecarManager) Status() SidecarStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

// Client implements the Sidecar contract — see interface docs.
//
// Returns nil before first successful Start. After Stop, the
// returned client is still non-nil but points at a port whose
// listener is gone — calls will fail with connection errors. The
// same dangling-handle problem applies in the Stuck state (Stop
// attempted but Wait did not confirm reap).
//
// Callers MUST treat the sidecar as unusable when
// `!Status().Running || Status().Stuck` — checking only Running
// misses the Stuck operator state, where the previous PID may
// still hold the loopback port and a naïve "if !Running { Start }"
// would refuse + leave the caller confused. The two flags together
// answer "is the sidecar usable RIGHT NOW".
func (m *SidecarManager) Client() *RestClient {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.client
}

// prePickPort binds 127.0.0.1:0, captures the OS-assigned port,
// then closes the listener. The returned port is intended for
// immediate writing into config.xml + spawn. There's a small race
// window between Close and the spawned syncthing's own bind — D9
// specifies one retry on collision, and Start's spawn loop retries
// prePickPort + ensureConfigXML + cmd.Start once if the first
// attempt fails.
func prePickPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	addr, ok := l.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("listener address is not *net.TCPAddr: %T", l.Addr())
	}
	return addr.Port, nil
}

func prePickSidecarPorts() (int, int, error) {
	guiLis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, 0, err
	}
	defer guiLis.Close()

	bepLis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, 0, err
	}
	defer bepLis.Close()

	guiAddr, ok := guiLis.Addr().(*net.TCPAddr)
	if !ok {
		return 0, 0, fmt.Errorf("gui listener address is not *net.TCPAddr: %T", guiLis.Addr())
	}
	bepAddr, ok := bepLis.Addr().(*net.TCPAddr)
	if !ok {
		return 0, 0, fmt.Errorf("bep listener address is not *net.TCPAddr: %T", bepLis.Addr())
	}
	return guiAddr.Port, bepAddr.Port, nil
}

// generateAPIKey returns a 32-byte random hex string. Per §3.7 D3,
// the key is ephemeral — never persisted, passed only via
// STGUIAPIKEY env at spawn time, regenerated every Start.
func generateAPIKey() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// pollHealthReady fires GET /rest/noauth/health every 100ms until
// either the request returns 200 OK or the ctx is done.
// /rest/noauth/health is an unauthenticated endpoint — no X-API-Key
// needed — designed precisely for "is the REST server up yet?"
// probes.
func pollHealthReady(ctx context.Context, client *RestClient) error {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("health-ready poll: %w", ctx.Err())
		case <-t.C:
			// Use a sub-context for each probe so a single slow
			// request doesn't stall the overall poll.
			probeCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
			_, err := client.do(probeCtx, "GET", "/rest/noauth/health", nil)
			cancel()
			if err == nil {
				return nil
			}
			// Continue polling on any error — network refused
			// during port-bind window, 503 during startup, etc.
			// ctx.Done() handles the timeout cap.
		}
	}
}
