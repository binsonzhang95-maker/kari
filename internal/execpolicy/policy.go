// Package execpolicy loads and evaluates the user's local-exec
// command policy, used by the desktop daemon to decide whether a command
// requested by a cloud Claude / Codex MCP bridge may run on this
// machine. The policy is intentionally simple — argv-prefix matching
// plus a small env-overlay whitelist — and intentionally fail-closed:
// any error loading the file (missing, malformed, permission) results
// in deny-all until the operator fixes it. There is no in-memory
// fallback to a previously-loaded policy.
package execpolicy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

// PathSeparator is the OS PATH list separator. Exposed so callers
// (the daemon's exec runner) don't need to hardcode it again when
// applying allow_path_prepend.
const PathSeparator = string(os.PathListSeparator)

// Wildcard is the trailing argv-element marker meaning "and anything
// after this." Only meaningful as the LAST element of an allow_argv
// entry; embedded wildcards are not supported (v1).
const Wildcard = "*"

// Decision codes mirror transport.LocalExecDenied* but live here too so
// the policy package has no dependency on internal/transport.
const (
	DeniedNoMatch      = "policy_no_match"
	DeniedExplicit     = "policy_denied"
	DeniedEmptyArgv    = "argv_invalid"
	DeniedPolicyLoad   = "policy_load_error"
	DeniedWorkspace    = "policy_no_workspace_rule"
	defaultMaxTimeout  = 600
	defaultCancelGrace = 5
)

// Policy is the deserialized JSON form of $KARI_HOME/exec-policy.json.
type Policy struct {
	Version            int    `json:"version"`
	Default            string `json:"default"` // "deny" only in v1
	MaxTimeoutSeconds  int    `json:"max_timeout_seconds,omitempty"`
	CancelGraceSeconds int    `json:"cancel_grace_seconds,omitempty"`
	Rules              []Rule `json:"rules"`
}

// Rule is one allowlist entry. AllowArgv is a list of argv-prefix
// patterns; each pattern is itself a slice of literal strings, with an
// optional trailing "*" meaning "any further args accepted." AllowEnv
// names the env variables that the bridge may override (exact match).
// AllowPathPrepend, when true, lets the bridge contribute a PATH
// prepend (never a full overwrite).
type Rule struct {
	Workspace        string     `json:"workspace"`
	DenyArgv         [][]string `json:"deny_argv,omitempty"`
	AllowArgv        [][]string `json:"allow_argv,omitempty"`
	AllowEnv         []string   `json:"allow_env,omitempty"`
	AllowPathPrepend bool       `json:"allow_path_prepend,omitempty"`
}

// Decision is what Match (or Decide) returns. On Allow=false,
// DeniedReason is one of the Denied* codes above. On Allow=true,
// AllowedEnv contains the env-overlay entries that survived filtering
// (the runner should apply only these), and PathOverlay is the value
// the bridge supplied for PATH if and only if the matched rule sets
// AllowPathPrepend (else empty).
type Decision struct {
	Allow              bool
	DeniedReason       string
	MatchedRule        int
	AllowedEnv         map[string]string
	PathOverlay        string
	MaxTimeoutSeconds  int
	CancelGraceSeconds int
}

// Loader caches the parsed policy and reloads on mtime change. Safe
// for concurrent Decide calls.
type Loader struct {
	path string
	mu   sync.RWMutex
	cur  *Policy
	stat os.FileInfo
	err  error
}

// NewLoader constructs a Loader for the given JSON file. The path is
// not opened until the first Load / Decide call so callers can
// construct it during daemon startup without ordering constraints.
func NewLoader(path string) *Loader {
	return &Loader{path: path}
}

// Path returns the file path the loader watches.
func (l *Loader) Path() string { return l.path }

// Load reads the policy file if mtime changed, otherwise returns the
// cached copy. Any error — including ENOENT — returns the error and a
// nil policy, telling the caller to fail closed. The previous good
// policy is NOT preserved when reload fails; a missing file means
// deny-all, not "last known state."
func (l *Loader) Load() (*Policy, error) {
	if l == nil || l.path == "" {
		return nil, errors.New("execpolicy: loader not configured")
	}
	stat, err := os.Stat(l.path)
	if err != nil {
		l.mu.Lock()
		l.cur = nil
		l.stat = nil
		l.err = err
		l.mu.Unlock()
		return nil, fmt.Errorf("execpolicy: stat %s: %w", l.path, err)
	}
	l.mu.RLock()
	if l.cur != nil && l.stat != nil && sameStat(l.stat, stat) {
		p := l.cur
		l.mu.RUnlock()
		return p, nil
	}
	l.mu.RUnlock()
	data, err := os.ReadFile(l.path)
	if err != nil {
		l.mu.Lock()
		l.cur = nil
		l.stat = nil
		l.err = err
		l.mu.Unlock()
		return nil, fmt.Errorf("execpolicy: read %s: %w", l.path, err)
	}
	var policy Policy
	if uerr := json.Unmarshal(data, &policy); uerr != nil {
		l.mu.Lock()
		l.cur = nil
		l.stat = nil
		l.err = uerr
		l.mu.Unlock()
		return nil, fmt.Errorf("execpolicy: parse %s: %w", l.path, uerr)
	}
	if policy.Default != "" && policy.Default != "deny" {
		err := fmt.Errorf("execpolicy: unsupported default policy %q (only \"deny\" supported)", policy.Default)
		l.mu.Lock()
		l.cur = nil
		l.stat = nil
		l.err = err
		l.mu.Unlock()
		return nil, err
	}
	if policy.MaxTimeoutSeconds <= 0 {
		policy.MaxTimeoutSeconds = defaultMaxTimeout
	}
	if policy.CancelGraceSeconds <= 0 {
		policy.CancelGraceSeconds = defaultCancelGrace
	}
	l.mu.Lock()
	l.cur = &policy
	l.stat = stat
	l.err = nil
	l.mu.Unlock()
	return &policy, nil
}

// Decide is the convenience entry point used by the daemon runner:
// load + match in one call. A load failure produces a Decision with
// Allow=false and DeniedReason=policy_load_error rather than panicking
// or falling back. envOverlay is the raw map the bridge requested; the
// returned Decision.AllowedEnv contains only the entries the policy
// allows for this match. Hard-denied entries (LD_PRELOAD, DYLD_*, etc)
// are stripped regardless of policy.
func (l *Loader) Decide(workspaceID string, argv []string, envOverlay map[string]string) Decision {
	if len(argv) == 0 || argv[0] == "" {
		return Decision{DeniedReason: DeniedEmptyArgv, MatchedRule: -1}
	}
	policy, err := l.Load()
	if err != nil || policy == nil {
		return Decision{DeniedReason: DeniedPolicyLoad, MatchedRule: -1}
	}
	return Match(policy, workspaceID, argv, envOverlay)
}

// Match runs the policy decision pure-functionally — no I/O, easy to
// table-test. Behavior: deny_argv rules for the workspace are checked
// first. If none match, walk Rules in order, looking for the first one
// whose Workspace pattern matches AND whose AllowArgv list contains a
// matching prefix. That rule's AllowEnv + AllowPathPrepend then govern
// env overlay filtering. No match → deny.
func Match(policy *Policy, workspaceID string, argv []string, envOverlay map[string]string) Decision {
	if policy == nil {
		return Decision{DeniedReason: DeniedPolicyLoad, MatchedRule: -1}
	}
	if len(argv) == 0 || argv[0] == "" {
		return Decision{DeniedReason: DeniedEmptyArgv, MatchedRule: -1}
	}
	for i, rule := range policy.Rules {
		if !matchWorkspace(rule.Workspace, workspaceID) {
			continue
		}
		if matchAnyArgv(rule.DenyArgv, argv) {
			return Decision{DeniedReason: DeniedExplicit, MatchedRule: i}
		}
	}
	for i, rule := range policy.Rules {
		if !matchWorkspace(rule.Workspace, workspaceID) {
			continue
		}
		if !matchAnyArgv(rule.AllowArgv, argv) {
			continue
		}
		allowed := filterEnv(envOverlay, rule.AllowEnv, rule.AllowPathPrepend)
		pathOverlay := ""
		if rule.AllowPathPrepend {
			if v, ok := envOverlay["PATH"]; ok {
				pathOverlay = v
			}
		}
		return Decision{
			Allow:              true,
			MatchedRule:        i,
			AllowedEnv:         allowed,
			PathOverlay:        pathOverlay,
			MaxTimeoutSeconds:  policy.MaxTimeoutSeconds,
			CancelGraceSeconds: policy.CancelGraceSeconds,
		}
	}
	return Decision{DeniedReason: DeniedNoMatch, MatchedRule: -1}
}

func matchWorkspace(pattern, workspaceID string) bool {
	if pattern == "" || pattern == Wildcard {
		return true
	}
	return pattern == workspaceID
}

func matchAnyArgv(patterns [][]string, argv []string) bool {
	for _, p := range patterns {
		if matchArgv(p, argv) {
			return true
		}
	}
	return false
}

func matchArgv(pattern, argv []string) bool {
	if len(pattern) == 0 {
		return false
	}
	hasTrailingWild := pattern[len(pattern)-1] == Wildcard
	literalLen := len(pattern)
	if hasTrailingWild {
		literalLen--
	}
	if hasTrailingWild {
		if len(argv) < literalLen {
			return false
		}
	} else {
		if len(argv) != literalLen {
			return false
		}
	}
	for i := 0; i < literalLen; i++ {
		if pattern[i] != argv[i] {
			return false
		}
	}
	return true
}

// Hard env-name deny list applied regardless of policy.
var hardDeniedEnv = []string{
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
}

// hardDeniedEnvPrefix matches "DYLD_*" and similar dynamic-linker
// hijack vectors. Prefix match is used because the macOS dynamic
// loader honours an open-ended family (DYLD_INSERT_LIBRARIES,
// DYLD_FORCE_FLAT_NAMESPACE, ...). Even if a future macOS strips them
// in SIP contexts, we strip them in user space too — defense in depth.
var hardDeniedEnvPrefix = []string{
	"DYLD_",
}

// filterEnv keeps only env entries that pass three gates: not in the
// hard-deny list (LD_PRELOAD etc), not PATH (unless allowPathPrepend
// AND we let the runner handle PATH separately via Decision.PathOverlay
// because prepend != overwrite), and present in rule.AllowEnv.
//
// AllowEnv "*" is intentionally not honoured: a global wildcard would
// defeat the point of an allowlist (a future Claude tool description
// change could start requesting NODE_OPTIONS=--require malware.js).
// Operators must enumerate.
func filterEnv(overlay map[string]string, allowEnv []string, allowPathPrepend bool) map[string]string {
	if len(overlay) == 0 {
		return nil
	}
	allowSet := make(map[string]struct{}, len(allowEnv))
	for _, name := range allowEnv {
		allowSet[name] = struct{}{}
	}
	out := make(map[string]string, len(overlay))
	for name, value := range overlay {
		if name == "" {
			continue
		}
		if name == "PATH" {
			// PATH is handled by the runner via Decision.PathOverlay so
			// we have prepend-only semantics. Never let it through the
			// regular env map even if the operator typo'd it into
			// allow_env.
			continue
		}
		if isHardDenied(name) {
			continue
		}
		if _, ok := allowSet[name]; !ok {
			continue
		}
		out[name] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func isHardDenied(name string) bool {
	for _, d := range hardDeniedEnv {
		if name == d {
			return true
		}
	}
	for _, p := range hardDeniedEnvPrefix {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// sameStat decides whether the on-disk policy file changed since we
// last cached it. ModTime + Size is the standard cheap test; we don't
// hash the contents (one stat per Decide call is already plenty).
//
// On platforms with sub-second mtime granularity this is fine; on the
// rare older filesystem with 2s mtime resolution a rapid edit-save
// loop might be missed for up to 2s. The daemon is a long-running
// process so the next request after that window will pick up the
// change — acceptable for a human-driven edit cadence.
func sameStat(a, b os.FileInfo) bool {
	if a == nil || b == nil {
		return false
	}
	if !a.ModTime().Equal(b.ModTime()) {
		return false
	}
	if a.Size() != b.Size() {
		return false
	}
	return true
}

// CapMaxTimeout returns the effective timeout for a request, clamped
// to the policy's max. requestedSec <= 0 means "use policy default".
func (p *Policy) CapMaxTimeout(requestedSec int) time.Duration {
	if p == nil {
		return time.Duration(defaultMaxTimeout) * time.Second
	}
	max := p.MaxTimeoutSeconds
	if max <= 0 {
		max = defaultMaxTimeout
	}
	if requestedSec <= 0 || requestedSec > max {
		return time.Duration(max) * time.Second
	}
	return time.Duration(requestedSec) * time.Second
}

// CancelGrace returns the policy's cancel grace period.
func (p *Policy) CancelGrace() time.Duration {
	if p == nil || p.CancelGraceSeconds <= 0 {
		return time.Duration(defaultCancelGrace) * time.Second
	}
	return time.Duration(p.CancelGraceSeconds) * time.Second
}

// DefaultPolicyPath returns $KARI_HOME/exec-policy.json (or the legacy
// $HOME/.kari/exec-policy.json fallback). Lifted out so the daemon and
// the (future) UI panel both compute the same path without depending
// on internal/config.
func DefaultPolicyPath() string {
	if env := os.Getenv("KARI_HOME"); env != "" {
		return joinPath(env, "exec-policy.json")
	}
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return joinPath(xdg, "kari", "exec-policy.json")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	if runtime.GOOS == "windows" {
		// On Windows the legacy $HOME/.kari is unusual but still honoured
		// for users who set KARI_HOME explicitly above. The XDG branch
		// covers the typical %APPDATA% case if the user sets it.
		return joinPath(home, ".kari", "exec-policy.json")
	}
	return joinPath(home, ".kari", "exec-policy.json")
}

// DefaultPolicyJSON is the first-run local-exec policy. It keeps the
// personal workflow permissive by allowing arbitrary argv by default,
// while blocking a small set of commands that are almost always
// destructive at machine scope. Existing user policy files are never
// overwritten with this template.
func DefaultPolicyJSON() []byte {
	return []byte(`{
  "version": 1,
  "default": "deny",
  "max_timeout_seconds": 600,
  "cancel_grace_seconds": 5,
  "rules": [
    {
      "workspace": "*",
      "deny_argv": [
        ["rm", "-rf", "/"],
        ["rm", "-rf", "/", "*"],
        ["rm", "-fr", "/"],
        ["rm", "-fr", "/", "*"],
        ["rm", "-rf", "/*"],
        ["rm", "-fr", "/*"],
        ["rm", "-rf", "~"],
        ["rm", "-fr", "~"],
        ["rm", "-rf", "$HOME"],
        ["rm", "-fr", "$HOME"],
        ["dd", "*"],
        ["mkfs", "*"],
        ["fdisk", "*"],
        ["diskutil", "eraseDisk", "*"],
        ["chmod", "-R", "777", "/"],
        ["chmod", "-R", "777", "/", "*"],
        ["chown", "-R", "*"],
        ["launchctl", "bootout", "*"],
        ["systemctl", "disable", "*"],
        ["systemctl", "stop", "*"]
      ],
      "allow_argv": [["*"]]
    }
  ]
}
`)
}

// EnsureDefaultPolicyFile writes DefaultPolicyJSON to path only when
// the policy file does not exist. Existing policies, including malformed
// ones, are left untouched so the operator's latest edit remains the
// source of truth.
func EnsureDefaultPolicyFile(path string) error {
	if path == "" {
		return errors.New("execpolicy: policy path is empty")
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	dir := dirName(path)
	if dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	return os.WriteFile(path, DefaultPolicyJSON(), 0o600)
}

func joinPath(parts ...string) string {
	if len(parts) == 0 {
		return ""
	}
	sep := string(os.PathSeparator)
	out := parts[0]
	for _, p := range parts[1:] {
		if !strings.HasSuffix(out, sep) {
			out += sep
		}
		out += p
	}
	return out
}

func dirName(path string) string {
	idx := strings.LastIndex(path, string(os.PathSeparator))
	if idx <= 0 {
		return ""
	}
	return path[:idx]
}
