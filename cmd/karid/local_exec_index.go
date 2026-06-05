package main

import (
	"errors"
	"strings"
	"sync"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// localExecSessionIndex tracks which daemons are currently connected and
// have advertised CapabilityLocalExec. Keyed by (workspace_id, client_id)
// — the routing requires both because a workspace may have several
// devices (license max_devices, typically 3) and only the one that
// owned the originating PTY session should receive the exec.
//
// Not reusing the existing sessionRegistry: that one's job is
// license/device caps and kick semantics, and it doesn't expose the
// underlying *filesync.Session (which we need to call
// SendLocalExecRequest on). Keeping the two concerns separate also
// means a daemon that loses CapabilityLocalExec in a future downgrade
// path can still hold a sync slot — its absence from this index just
// means RouteLocalExec returns "unsupported".
type localExecSessionIndex struct {
	mu          sync.Mutex
	byWorkspace map[string]map[string]*localExecSyncSession
}

type localExecSyncSession struct {
	workspaceID string
	clientID    string
	session     *filesync.Session
	caps        []string
}

var (
	errLocalExecDaemonOffline = errors.New("local desktop daemon not connected")
	errLocalExecUnsupported   = errors.New("local exec unsupported; upgrade Kari Desktop")
)

func newLocalExecSessionIndex() *localExecSessionIndex {
	return &localExecSessionIndex{
		byWorkspace: map[string]map[string]*localExecSyncSession{},
	}
}

// register stores the session under (workspaceID, clientID). If another
// session is already registered under the same key (daemon reconnect
// during a brief network blip), it is overwritten — the new connection
// is the authoritative one. The returned unregister function safely
// no-ops if the entry has since been replaced; see unregister doc.
func (idx *localExecSessionIndex) register(workspaceID, clientID string, session *filesync.Session, caps []string) func() {
	if idx == nil || workspaceID == "" || clientID == "" || session == nil {
		return func() {}
	}
	idx.mu.Lock()
	bucket, ok := idx.byWorkspace[workspaceID]
	if !ok {
		bucket = map[string]*localExecSyncSession{}
		idx.byWorkspace[workspaceID] = bucket
	}
	bucket[clientID] = &localExecSyncSession{
		workspaceID: workspaceID,
		clientID:    clientID,
		session:     session,
		caps:        append([]string(nil), caps...),
	}
	idx.mu.Unlock()
	return func() {
		idx.unregister(workspaceID, clientID, session)
	}
}

// unregister removes the (workspaceID, clientID) entry only if it still
// points at the supplied session pointer. The pointer-equality guard
// matters during reconnect: an old connection's deferred unregister
// runs AFTER the new connection's register has already overwritten the
// slot, and without this check it would erase the live entry. Compare
// the same defensive pattern used by sessionRegistry in sessions.go.
func (idx *localExecSessionIndex) unregister(workspaceID, clientID string, session *filesync.Session) {
	if idx == nil {
		return
	}
	idx.mu.Lock()
	defer idx.mu.Unlock()
	bucket := idx.byWorkspace[workspaceID]
	if bucket == nil {
		return
	}
	cur, ok := bucket[clientID]
	if !ok || cur.session != session {
		return
	}
	delete(bucket, clientID)
	if len(bucket) == 0 {
		delete(idx.byWorkspace, workspaceID)
	}
}

// lookup returns the registered session for (workspaceID, clientID).
// Three return values rather than (entry, error) so call sites can
// distinguish "offline" from "online but missing capability" — both
// produce specific MCP-layer messages so the LLM can react sensibly
// ("daemon is offline, retry later" vs "user must update their app").
func (idx *localExecSessionIndex) lookup(workspaceID, clientID string) (*filesync.Session, []string, error) {
	if idx == nil || workspaceID == "" || clientID == "" {
		return nil, nil, errLocalExecDaemonOffline
	}
	idx.mu.Lock()
	defer idx.mu.Unlock()
	bucket := idx.byWorkspace[workspaceID]
	if bucket == nil {
		return nil, nil, errLocalExecDaemonOffline
	}
	entry := bucket[clientID]
	if entry == nil {
		return nil, nil, errLocalExecDaemonOffline
	}
	if !hasCapability(entry.caps, transport.CapabilityLocalExec) {
		return entry.session, entry.caps, errLocalExecUnsupported
	}
	return entry.session, entry.caps, nil
}

func hasCapability(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

// resolveClientFor returns the desktop client_id local_shell_exec may
// target. If the OpenAI-compatible request declared an originating
// client_id, only that exact online/capable daemon is accepted. If it
// did not, we fall back only when there is a single capable daemon for
// the workspace; multiple candidates return "" so we do not silently
// execute on the wrong desktop.
func (idx *localExecSessionIndex) resolveClientFor(workspaceID, preferredClientID string) string {
	preferredClientID = strings.TrimSpace(preferredClientID)
	if preferredClientID != "" {
		if _, _, err := idx.lookup(workspaceID, preferredClientID); err == nil {
			return preferredClientID
		}
		return ""
	}
	return idx.onlyClientFor(workspaceID)
}

func (idx *localExecSessionIndex) onlyClientFor(workspaceID string) string {
	if idx == nil || workspaceID == "" {
		return ""
	}
	idx.mu.Lock()
	bucket := idx.byWorkspace[workspaceID]
	candidates := make([]string, 0, len(bucket))
	for id, entry := range bucket {
		if entry != nil && hasCapability(entry.caps, transport.CapabilityLocalExec) {
			candidates = append(candidates, id)
		}
	}
	idx.mu.Unlock()
	if len(candidates) == 0 {
		return ""
	}
	if len(candidates) > 1 {
		return ""
	}
	return candidates[0]
}
