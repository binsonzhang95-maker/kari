package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// localExecRouter is the server-side entry point for MCP-bridge tool
// calls. It wraps localExecSessionIndex with bridge bookkeeping: each
// bridge sidecar (one per Claude/Codex PTY session on this server)
// declares a bridge_id, and the router tracks which in-flight request
// ids belong to which bridge so it can cancel them all when the bridge
// disconnects (Claude exited, MCP stdio closed, internal connection
// broken).
type localExecRouter struct {
	sessions *localExecSessionIndex

	mu       sync.Mutex
	bridges  map[string]*localExecBridgeState // bridge_id → state
	requests map[string]*localExecRequestRef  // request_id → owning bridge_id + session ptr (for cleanup routing)
}

type localExecBridgeState struct {
	id          string
	workspaceID string
	clientID    string
	requestIDs  map[string]struct{}
}

type localExecRequestRef struct {
	bridgeID string
	session  *filesync.Session
}

func newLocalExecRouter(index *localExecSessionIndex) *localExecRouter {
	return &localExecRouter{
		sessions: index,
		bridges:  map[string]*localExecBridgeState{},
		requests: map[string]*localExecRequestRef{},
	}
}

// RegisterBridge announces a new MCP bridge sidecar. workspaceID +
// clientID identify the desktop the bridge's owning Claude session is
// scoped to; we record them on the bridge state so cleanup can issue
// cancels without re-looking-up the index (the session may have
// disconnected by then). The returned id is generated server-side so
// the bridge can't spoof another bridge's id.
func (r *localExecRouter) RegisterBridge(workspaceID, clientID string) (string, error) {
	if workspaceID == "" || clientID == "" {
		return "", errors.New("workspace_id and client_id are required")
	}
	id, err := newRandomID(16)
	if err != nil {
		return "", err
	}
	r.mu.Lock()
	r.bridges[id] = &localExecBridgeState{
		id:          id,
		workspaceID: workspaceID,
		clientID:    clientID,
		requestIDs:  map[string]struct{}{},
	}
	r.mu.Unlock()
	return id, nil
}

// UnregisterBridge is called when the bridge process exits or its
// internal connection closes. All in-flight requests for that bridge
// get a synthetic "bridge disconnected" Done routed through their
// waiters (so any RouteLocalExec caller still ranging over the event
// channel exits cleanly) AND a MessageLocalExecCancel travels back to
// the daemon so the underlying process is killed. Both effects come
// from filesync.Session.CleanupLocalExecWaitersFor.
func (r *localExecRouter) UnregisterBridge(bridgeID string) {
	if bridgeID == "" {
		return
	}
	r.mu.Lock()
	state, ok := r.bridges[bridgeID]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.bridges, bridgeID)
	requestIDs := make([]string, 0, len(state.requestIDs))
	sessions := map[*filesync.Session][]string{}
	for rid := range state.requestIDs {
		requestIDs = append(requestIDs, rid)
		if ref := r.requests[rid]; ref != nil {
			sessions[ref.session] = append(sessions[ref.session], rid)
		}
		delete(r.requests, rid)
	}
	r.mu.Unlock()
	for session, ids := range sessions {
		if session != nil {
			session.CleanupLocalExecWaitersFor(ids)
		}
	}
}

// BridgeMatches reports whether bridgeID is currently registered under
// the workspace/client pair authenticated by the loopback token.
func (r *localExecRouter) BridgeMatches(bridgeID, workspaceID, clientID string) bool {
	if r == nil || bridgeID == "" || workspaceID == "" || clientID == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.bridges[bridgeID]
	return state != nil && state.workspaceID == workspaceID && state.clientID == clientID
}

// Route dispatches a single exec request and returns a channel of
// LocalExecEvent. The channel is closed by the session's recvLoop
// after the final Done lands (or by CleanupLocalExecWaitersFor on
// bridge teardown).
//
// The returned cancel func must be called by the caller on any exit
// path (normal completion, ctx cancel, error). It removes per-request
// bookkeeping AND, if the request hasn't completed yet, sends a
// MessageLocalExecCancel to the daemon to abort the running process.
//
// Errors: errLocalExecDaemonOffline if no matching desktop is
// connected; errLocalExecUnsupported if connected but missing
// CapabilityLocalExec; filesync.ErrLocalExecBusy if the request_id
// collides or the wire queue is full.
func (r *localExecRouter) Route(ctx context.Context, bridgeID string, req transport.LocalExecRequest) (<-chan filesync.LocalExecEvent, func(), error) {
	r.mu.Lock()
	state, ok := r.bridges[bridgeID]
	if !ok {
		r.mu.Unlock()
		return nil, nil, errors.New("unknown bridge_id")
	}
	workspaceID := state.workspaceID
	clientID := state.clientID
	r.mu.Unlock()

	session, _, err := r.sessions.lookup(workspaceID, clientID)
	if err != nil {
		return nil, nil, err
	}
	if req.RequestID == "" {
		id, idErr := newRandomID(12)
		if idErr != nil {
			return nil, nil, idErr
		}
		req.RequestID = id
	}
	events, sessionCancel, err := session.SendLocalExecRequest(req)
	if err != nil {
		return nil, nil, err
	}
	r.mu.Lock()
	state, ok = r.bridges[bridgeID]
	if !ok {
		// Bridge was unregistered while we were dispatching. Clean up
		// and bubble error so the caller knows the request never
		// reached the wire (from its perspective).
		r.mu.Unlock()
		sessionCancel()
		return nil, nil, errors.New("bridge unregistered during dispatch")
	}
	state.requestIDs[req.RequestID] = struct{}{}
	r.requests[req.RequestID] = &localExecRequestRef{bridgeID: bridgeID, session: session}
	r.mu.Unlock()

	requestID := req.RequestID
	cleanup := func() {
		r.mu.Lock()
		if state, ok := r.bridges[bridgeID]; ok {
			delete(state.requestIDs, requestID)
		}
		delete(r.requests, requestID)
		r.mu.Unlock()
		sessionCancel()
	}
	// Watch ctx so a bridge timeout or LLM-side abort propagates a
	// cancel envelope to the daemon without waiting for the caller to
	// notice. We don't touch the events channel here — the caller is
	// the only consumer and we'd corrupt their stream by stealing an
	// event. Cleanup is idempotent (the session-level cancel checks
	// the waiter map), so the caller's normal-exit cleanup() AND this
	// goroutine's cleanup() can both fire without harm.
	go func() {
		<-ctx.Done()
		cleanup()
	}()
	return events, cleanup, nil
}

func newRandomID(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
