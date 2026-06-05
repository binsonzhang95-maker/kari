package syncd

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// LocalExecAuditPath resolves to $KARI_HOME/exec-audit.jsonl with the
// same precedence rules as execpolicy.DefaultPolicyPath. Exported so
// the daemon's HTTP routes can serve `GET /v1/exec-history` from the
// same file the runner writes to. Returns "" when $HOME / $KARI_HOME
// cannot be determined — callers should treat that as "audit disabled".
func LocalExecAuditPath() string {
	if env := os.Getenv("KARI_HOME"); env != "" {
		return filepath.Join(env, "exec-audit.jsonl")
	}
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "kari", "exec-audit.jsonl")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	_ = runtime.GOOS // platform-agnostic v1; reserved for future split
	return filepath.Join(home, ".kari", "exec-audit.jsonl")
}

// auditMaxBytes is the rotate threshold for the local-exec audit log.
// 50 MiB matches the v2.1 plan. When the active file crosses this on
// the next append, we rename it to .1 (existing .1 → .2, .2 → .3, .3
// dropped) and open a fresh file.
const auditMaxBytes int64 = 50 * 1024 * 1024

// auditKeptBackups is how many rotated copies we retain. 3 backups +
// the active file = 4 files total, ~200 MiB worst case on disk.
const auditKeptBackups = 3

// auditEntry is one line in $KARI_HOME/exec-audit.jsonl. Argv is
// stored verbatim — diagnostics need to know what the LLM asked for.
type auditEntry struct {
	Timestamp    time.Time `json:"ts"`
	Workspace    string    `json:"workspace"`
	RequestID    string    `json:"request_id"`
	Argv         []string  `json:"argv"`
	CWD          string    `json:"cwd,omitempty"`
	Decision     string    `json:"decision"`
	DeniedReason string    `json:"denied_reason,omitempty"`
	ExitCode     int       `json:"exit_code"`
	DurationMS   int64     `json:"duration_ms"`
	Truncated    bool      `json:"truncated,omitempty"`
	OutputBytes  int64     `json:"output_bytes,omitempty"`
	Error        string    `json:"error,omitempty"`
	MatchedRule  int       `json:"matched_rule,omitempty"`
}

// auditLog is a write-mostly rotating jsonl. We accept the small cost
// of opening a file per write because (a) the runner already pays one
// fork+exec for each request and (b) holding a long-lived fd would
// make rotation racy across multiple syncd processes (one per
// workspace) writing to the same shared file.
type auditLog struct {
	path string
	mu   sync.Mutex
}

func newAuditLog(path string) *auditLog {
	return &auditLog{path: path}
}

func (a *auditLog) write(entry auditEntry) {
	if a == nil || a.path == "" {
		return
	}
	entry.Timestamp = time.Now().UTC()
	line, err := json.Marshal(entry)
	if err != nil {
		log.Printf("exec audit: marshal: %v", err)
		return
	}
	line = append(line, '\n')

	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.rotateIfNeeded(int64(len(line))); err != nil {
		log.Printf("exec audit: rotate: %v", err)
		// Continue — better to write to an oversized file than to drop
		// the entry entirely. Operator's next start will rotate it.
	}

	f, err := os.OpenFile(a.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		log.Printf("exec audit: open %s: %v", a.path, err)
		return
	}
	defer f.Close()
	if _, err := f.Write(line); err != nil {
		log.Printf("exec audit: write %s: %v", a.path, err)
	}
}

// rotateIfNeeded checks the current size and shifts the backup chain
// when an append would push it past auditMaxBytes. Errors are
// non-fatal — the caller logs and proceeds to append regardless.
func (a *auditLog) rotateIfNeeded(incomingBytes int64) error {
	stat, err := os.Stat(a.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if stat.Size()+incomingBytes < auditMaxBytes {
		return nil
	}
	// Drop the oldest, shift everything down by one. If a previous
	// rotation aborted, some intermediate files may be missing — the
	// Remove on a non-existent path is a no-op (ENOENT), so the chain
	// still ends up consistent.
	oldest := a.path + "." + strconv.Itoa(auditKeptBackups)
	_ = os.Remove(oldest)
	for i := auditKeptBackups - 1; i >= 1; i-- {
		from := a.path + "." + strconv.Itoa(i)
		to := a.path + "." + strconv.Itoa(i+1)
		if _, err := os.Stat(from); err == nil {
			if err := os.Rename(from, to); err != nil {
				return err
			}
		}
	}
	return os.Rename(a.path, a.path+".1")
}
