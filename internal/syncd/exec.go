package syncd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/execpolicy"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// LocalExecRunnerConfig is the construction-time configuration shared by
// every LocalExecRunner instance. Loader is shared (single policy file
// covers all workspaces); BasePath is the user-shell-derived PATH the
// daemon resolved once at startup. AuditPath is the rotating jsonl
// file we append every decision to.
type LocalExecRunnerConfig struct {
	Loader         *execpolicy.Loader
	BasePath       string
	AuditPath      string
	MaxOutputBytes int64
	MaxOutputRate  int64 // bytes per second
}

// defaultLocalExecMaxOutputBytes caps a single request's combined
// stdout+stderr at 10 MiB. The runner stops forwarding chunks past
// that, marks Truncated=true, and lets the underlying process keep
// running until exit (we don't conflate "too much output" with "this
// run should die"; an `npm install` that prints 20 MB of postinstall
// noise is still useful for its exit code).
const defaultLocalExecMaxOutputBytes int64 = 10 * 1024 * 1024

// defaultLocalExecMaxOutputRate caps sustained chunk throughput at
// 1 MiB/sec. Per-second token-bucket; bursts up to maxOutputBytes are
// allowed but a steady firehose is throttled so a long-running
// `tail -f` doesn't dominate the sync stream's bandwidth budget.
const defaultLocalExecMaxOutputRate int64 = 1 * 1024 * 1024

// LocalExecRunner runs argv-style commands the cloud MCP bridge
// requests via the sync stream. Each NewLocalExecRunner is bound to
// one (workspace_id, workspace_root) pair so cwd resolution and audit
// records can be scoped to the right tree. The Handle method is the
// callback installed on filesync.Session via SetLocalExecHandler.
type LocalExecRunner struct {
	cfg           LocalExecRunnerConfig
	workspaceID   string
	workspaceRoot string
	audit         *auditLog
	maxBytes      int64
	maxRate       int64
}

// NewLocalExecRunner constructs the runner. Returns nil if the platform
// can't enforce cancellation safely — Windows without Job Object falls
// here in v1 and the syncd wiring uses that to suppress capability
// advertisement (no CapabilityLocalExec → server's RouteLocalExec
// returns "unsupported"). See exec_unix.go / exec_windows.go.
func NewLocalExecRunner(cfg LocalExecRunnerConfig, workspaceID, workspaceRoot string) *LocalExecRunner {
	if !localExecPlatformSupported() {
		return nil
	}
	max := cfg.MaxOutputBytes
	if max <= 0 {
		max = defaultLocalExecMaxOutputBytes
	}
	rate := cfg.MaxOutputRate
	if rate <= 0 {
		rate = defaultLocalExecMaxOutputRate
	}
	return &LocalExecRunner{
		cfg:           cfg,
		workspaceID:   workspaceID,
		workspaceRoot: workspaceRoot,
		audit:         newAuditLog(cfg.AuditPath),
		maxBytes:      max,
		maxRate:       rate,
	}
}

// Handle is the filesync.Session.SetLocalExecHandler callback.
func (r *LocalExecRunner) Handle(ctx context.Context, req transport.LocalExecRequest, emit func(transport.LocalExecOutput)) transport.LocalExecDone {
	started := time.Now()
	done := transport.LocalExecDone{RequestID: req.RequestID, ExitCode: -1}

	if r == nil {
		done.Error = "local exec not configured on this daemon"
		done.DurationMS = time.Since(started).Milliseconds()
		return done
	}

	// argv first: a deny here doesn't even touch the policy loader.
	if len(req.Argv) == 0 || req.Argv[0] == "" {
		done.DeniedReason = execpolicy.DeniedEmptyArgv
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, Decision: "deny", DeniedReason: done.DeniedReason,
			ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}

	// cwd: must be relative, must stay inside the workspace root after
	// symlink normalisation. Empty cwd means workspace root.
	resolvedCWD, cwdErr := r.resolveCWD(req.CWD)
	if cwdErr != nil {
		done.DeniedReason = transport.LocalExecDeniedBadCWD
		done.Error = cwdErr.Error()
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, CWD: req.CWD, Decision: "deny", DeniedReason: done.DeniedReason,
			Error: done.Error, ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}

	// Policy decision. A load failure here translates to deny-all per
	// the fail-closed contract — see internal/execpolicy.
	decision := r.cfg.Loader.Decide(r.workspaceID, req.Argv, req.EnvOverlay)
	if !decision.Allow {
		done.DeniedReason = decision.DeniedReason
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, CWD: req.CWD, Decision: "deny", DeniedReason: done.DeniedReason,
			ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}

	policy, _ := r.cfg.Loader.Load() // already loaded once via Decide; ignore err — Decide would have denied.
	timeout := policy.CapMaxTimeout(req.TimeoutSeconds)
	graceDur := policy.CancelGrace()

	cmdCtx, cmdCancel := context.WithTimeout(ctx, timeout)
	defer cmdCancel()

	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Dir = resolvedCWD
	cmd.Env = r.buildEnv(decision)

	// processGroup owns platform-specific containment state. On
	// Windows it holds a Job Object handle; on POSIX it's empty. Apply
	// runs BEFORE cmd.Start (sets CREATE_SUSPENDED / Setpgid), afterStart
	// runs AFTER (Windows: assigns to job + resumes; POSIX: no-op),
	// watchCancel handles the cancel path, close releases the handle.
	// defer pg.close as early as possible so every pipe/Start/afterStart
	// error path runs the cleanup.
	pg, pgErr := newProcessGroup()
	if pgErr != nil {
		done.Error = "process_group_init: " + pgErr.Error()
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, CWD: req.CWD, Decision: "error",
			Error: done.Error, ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}
	defer pg.close()
	pg.apply(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		done.Error = "stdout pipe: " + err.Error()
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, CWD: req.CWD, Decision: "error",
			Error: done.Error, ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		done.Error = "stderr pipe: " + err.Error()
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, CWD: req.CWD, Decision: "error",
			Error: done.Error, ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}
	if err := cmd.Start(); err != nil {
		done.Error = "spawn: " + err.Error()
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, CWD: req.CWD, Decision: "error",
			Error: done.Error, ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}

	// pg.afterStart contract: returns nil → process is in the job and
	// running (Windows: assigned + resumed; POSIX: no-op). Returns err
	// → the suspended child has been TerminateProcess'd; we MUST still
	// cmd.Wait() to release Go's process handle + the pipes we hold
	// references to, otherwise the relay goroutines below would
	// deadlock on a never-connected pipe.
	if err := pg.afterStart(cmd); err != nil {
		_ = cmd.Wait()
		done.Error = "after_start: " + err.Error()
		done.DurationMS = time.Since(started).Milliseconds()
		r.audit.write(auditEntry{
			Workspace: r.workspaceID, RequestID: req.RequestID,
			Argv: req.Argv, CWD: req.CWD, Decision: "error",
			Error: done.Error, ExitCode: done.ExitCode, DurationMS: done.DurationMS,
		})
		return done
	}

	cap := &outputCap{
		maxBytes:    r.maxBytes,
		ratePerSec:  r.maxRate,
		windowStart: time.Now(),
	}
	var seq atomic.Int64
	relayWG := sync.WaitGroup{}
	relayWG.Add(2)
	go r.relayStream(stdout, "stdout", req.RequestID, &seq, cap, emit, &relayWG)
	go r.relayStream(stderr, "stderr", req.RequestID, &seq, cap, emit, &relayWG)

	// Cancellation watcher: when cmdCtx fires (timeout, parent cancel,
	// or upstream MessageLocalExecCancel), the watcher kills the
	// process tree — POSIX: SIGTERM → grace → SIGKILL of the pgid;
	// Windows: TerminateJobObject. The watcher exits when the process
	// exits naturally too — see waitFinished.
	//
	// watcherDone is the race-prevention pattern Phase 3 tests prove
	// is necessary: Windows watchCancel reads pg.hJob, so we MUST
	// join the goroutine before defer pg.close() runs CloseHandle.
	// Without it the deferred cmdCancel below could wake the watcher
	// AFTER pg.close has zeroed hJob, and TerminateJobObject would
	// be called on a stale handle.
	waitFinished := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		pg.watchCancel(cmd, cmdCtx, graceDur, waitFinished)
	}()

	waitErr := cmd.Wait()
	close(waitFinished)
	relayWG.Wait()
	<-watcherDone

	// Branch order matters: a process killed by our cancel path
	// surfaces as *exec.ExitError on BOTH platforms — POSIX SIGKILL
	// produces ExitCode==-1, Windows TerminateJobObject(hJob, 1)
	// produces ExitCode==1. Either way, asExitError(waitErr) would
	// match. Check cmdCtx.Err() FIRST so cancel/timeout aren't
	// silently reported as "exit -1" / "exit 1" with empty Error.
	if waitErr != nil && cmdCtx.Err() != nil {
		// Process was killed by our cancel path. Distinguish timeout
		// (policy.MaxTimeoutSeconds elapsed) from cancel (upstream
		// MessageLocalExecCancel or parent ctx) so the audit log +
		// the LLM-facing error are unambiguous.
		done.ExitCode = -1
		if errors.Is(cmdCtx.Err(), context.DeadlineExceeded) {
			done.Error = "timeout"
		} else {
			done.Error = "cancelled"
		}
	} else if exitErr, ok := asExitError(waitErr); ok {
		done.ExitCode = exitErr.ExitCode()
	} else if waitErr != nil {
		done.ExitCode = -1
		done.Error = waitErr.Error()
	} else {
		done.ExitCode = 0
	}

	done.OutputBytes = cap.totalBytes()
	if trunc, reason := cap.truncated(); trunc {
		done.Truncated = true
		done.TruncatedReason = reason
	}
	done.DurationMS = time.Since(started).Milliseconds()
	r.audit.write(auditEntry{
		Workspace:    r.workspaceID,
		RequestID:    req.RequestID,
		Argv:         req.Argv,
		CWD:          req.CWD,
		Decision:     "allow",
		ExitCode:     done.ExitCode,
		DurationMS:   done.DurationMS,
		Truncated:    done.Truncated,
		OutputBytes:  done.OutputBytes,
		Error:        done.Error,
		MatchedRule:  decision.MatchedRule,
	})
	return done
}

// resolveCWD enforces three rules: cwd may be empty (means workspace
// root), must be a RELATIVE path (absolute → reject), and after symlink
// evaluation the final path must remain inside the workspace root.
// The check uses filepath.EvalSymlinks so a symlink-out-of-root attack
// fails closed; missing-file is fine (the user may want to run a
// command that creates the dir, e.g. `mkdir -p && cd`).
func (r *LocalExecRunner) resolveCWD(rel string) (string, error) {
	if r.workspaceRoot == "" {
		return "", errors.New("workspace root not configured")
	}
	rootAbs, err := filepath.Abs(r.workspaceRoot)
	if err != nil {
		return "", err
	}
	if rel == "" {
		return rootAbs, nil
	}
	if filepath.IsAbs(rel) {
		return "", errors.New("cwd must be relative to workspace root")
	}
	joined := filepath.Join(rootAbs, rel)
	cleaned := filepath.Clean(joined)
	if !pathInside(rootAbs, cleaned) {
		return "", errors.New("cwd escapes workspace root")
	}
	// Resolve symlinks if the path exists; if it doesn't, accept the
	// cleaned form (the program may create it). pathInside already
	// blocked .. traversal so the lexical guard is enough for the
	// missing-path case.
	if _, statErr := os.Stat(cleaned); statErr == nil {
		resolved, evalErr := filepath.EvalSymlinks(cleaned)
		if evalErr != nil {
			return "", evalErr
		}
		// Re-resolve root too so a symlinked-root daemon (e.g. /Volumes/...)
		// doesn't false-negative the inside check.
		resolvedRoot, evalRootErr := filepath.EvalSymlinks(rootAbs)
		if evalRootErr != nil {
			return "", evalRootErr
		}
		if !pathInside(resolvedRoot, resolved) {
			return "", errors.New("cwd resolves outside workspace root")
		}
		return resolved, nil
	}
	return cleaned, nil
}

func pathInside(root, candidate string) bool {
	rootClean := filepath.Clean(root)
	candClean := filepath.Clean(candidate)
	if rootClean == candClean {
		return true
	}
	prefix := rootClean
	if !strings.HasSuffix(prefix, string(os.PathSeparator)) {
		prefix += string(os.PathSeparator)
	}
	return strings.HasPrefix(candClean, prefix)
}

// buildEnv produces the env slice for the child: a copy of the daemon
// env with PATH replaced by the resolved BasePath, then the policy-
// allowed overlay entries (which by construction don't include PATH).
// If the policy allows path prepend and the request supplied a PATH
// fragment, that fragment is prepended to BasePath.
func (r *LocalExecRunner) buildEnv(decision execpolicy.Decision) []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+len(decision.AllowedEnv)+1)
	effectivePath := r.cfg.BasePath
	if effectivePath == "" {
		effectivePath = os.Getenv("PATH")
	}
	if decision.PathOverlay != "" {
		effectivePath = decision.PathOverlay + execpolicy.PathSeparator + effectivePath
	}
	pathStamped := false
	for _, kv := range base {
		if strings.HasPrefix(kv, "PATH=") {
			out = append(out, "PATH="+effectivePath)
			pathStamped = true
			continue
		}
		// Drop any base-env hard-denied entries so a daemon inheriting
		// a hostile env doesn't pass the danger downstream. (Defense in
		// depth — the daemon shouldn't have those set, but if it does,
		// the child shouldn't see them either.)
		if envNameIsHardDenied(kv) {
			continue
		}
		out = append(out, kv)
	}
	if !pathStamped {
		out = append(out, "PATH="+effectivePath)
	}
	for k, v := range decision.AllowedEnv {
		out = append(out, k+"="+v)
	}
	return out
}

func envNameIsHardDenied(kv string) bool {
	eq := strings.IndexByte(kv, '=')
	if eq <= 0 {
		return false
	}
	name := kv[:eq]
	switch name {
	case "LD_PRELOAD", "LD_LIBRARY_PATH":
		return true
	}
	return strings.HasPrefix(name, "DYLD_")
}

// relayStream copies stdout/stderr through the output cap and emits
// chunks. Truncation is graceful: once the cap rejects more bytes, we
// keep draining the pipe (so the child doesn't block on a full PIPE
// buffer) but stop sending emit envelopes. The drained-but-dropped
// bytes still count toward OutputBytes via cap.totalBytes().
func (r *LocalExecRunner) relayStream(rc io.ReadCloser, stream, requestID string, seq *atomic.Int64, cap *outputCap, emit func(transport.LocalExecOutput), wg *sync.WaitGroup) {
	defer wg.Done()
	defer rc.Close()
	buf := make([]byte, 32*1024)
	for {
		n, err := rc.Read(buf)
		if n > 0 {
			data := append([]byte(nil), buf[:n]...)
			accepted := cap.accept(int64(n))
			if accepted > 0 {
				if accepted < int64(n) {
					data = data[:accepted]
				}
				emit(transport.LocalExecOutput{
					RequestID: requestID,
					Stream:    stream,
					Data:      data,
					Seq:       seq.Add(1),
				})
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			// File handles may close mid-read when we kill the process.
			// That's fine — exit the goroutine without logging.
			return
		}
	}
}

// outputCap is a tiny token-bucket-style rate + total-bytes limiter
// shared by the stdout and stderr goroutines for one request. accept
// returns how many of the requested bytes may pass; the rest are
// dropped (counted toward Truncated). The cap is mu-guarded because
// both pipe readers call it concurrently.
type outputCap struct {
	mu             sync.Mutex
	maxBytes       int64
	ratePerSec     int64
	used           int64
	windowStart    time.Time
	windowUsed     int64
	truncatedFlag  bool
	truncatedCause string
}

func (c *outputCap) accept(want int64) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Total-bytes cap first — cheaper, no clock math.
	remainingTotal := c.maxBytes - c.used
	if remainingTotal <= 0 {
		if !c.truncatedFlag {
			c.truncatedFlag = true
			c.truncatedCause = transport.LocalExecTruncatedMaxBytes
		}
		c.used += want // count dropped bytes toward total so the audit log shows true volume
		return 0
	}
	if want > remainingTotal {
		if !c.truncatedFlag {
			c.truncatedFlag = true
			c.truncatedCause = transport.LocalExecTruncatedMaxBytes
		}
		c.used += want
		return remainingTotal
	}
	// Rate cap. One-second window: reset windowUsed each time we cross
	// a second boundary. If the new write would push windowUsed past
	// ratePerSec, drop the overflow.
	now := time.Now()
	if now.Sub(c.windowStart) >= time.Second {
		c.windowStart = now
		c.windowUsed = 0
	}
	remainingWindow := c.ratePerSec - c.windowUsed
	if remainingWindow <= 0 {
		if !c.truncatedFlag {
			c.truncatedFlag = true
			c.truncatedCause = transport.LocalExecTruncatedRateLimit
		}
		c.used += want
		return 0
	}
	if want > remainingWindow {
		if !c.truncatedFlag {
			c.truncatedFlag = true
			c.truncatedCause = transport.LocalExecTruncatedRateLimit
		}
		c.windowUsed += remainingWindow
		c.used += want
		return remainingWindow
	}
	c.windowUsed += want
	c.used += want
	return want
}

func (c *outputCap) totalBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.used
}

func (c *outputCap) truncated() (bool, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.truncatedFlag, c.truncatedCause
}

func asExitError(err error) (*exec.ExitError, bool) {
	if err == nil {
		return nil, false
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee, true
	}
	return nil, false
}

// trimForLog truncates audit-log strings to a sensible cap — argv
// arrays from a curl-built script can be 100 KB long, and we don't
// want one rogue request to bloat the audit jsonl.
func trimForLog(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…(truncated)"
}

// joinArgvForLog is a small helper for the audit jsonl that keeps the
// log line compact regardless of argv length. We store the raw Argv
// slice in the JSON record itself; this helper is only used for log
// strings.
func joinArgvForLog(argv []string) string {
	var buf bytes.Buffer
	for i, a := range argv {
		if i > 0 {
			buf.WriteByte(' ')
		}
		buf.WriteString(a)
	}
	return trimForLog(buf.String(), 256)
}
