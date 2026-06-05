package syncd

import (
	"errors"
	"strings"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// BootstrapState is the daemon-side mirror of transport.BootstrapResult
// plus a timestamp. Surfaced via /v1/bootstrap-status for the workbench
// to poll. Status="pending" while the server is running git clone;
// "ok"/"clone_failed"/etc once the result comes back.
type BootstrapState struct {
	Status  string    `json:"status,omitempty"`
	Error   string    `json:"error,omitempty"`
	LogTail string    `json:"log_tail,omitempty"`
	Files   int       `json:"files,omitempty"`
	Bytes   int64     `json:"bytes,omitempty"`
	URL     string    `json:"url,omitempty"`      // redacted
	RepoURL string    `json:"repo_url,omitempty"` // redacted server remote URL
	At      time.Time `json:"at,omitempty"`
}

// Transfers proxies through to the live session's engine. Returns an
// empty slice (not nil) when no session is alive so the JSON endpoint
// gives `[]` instead of `null`.
//
// PR2 Phase 1 commit 4: injects the active session's workspace_id +
// workspace_name into each row so Desktop can route progress to the
// correct project card. The engine itself doesn't know the
// per-license workspace_id (it's keyed by (workspace_id,
// workspace_name) at the cmd/server side but the kari-syncd Engine
// is per-Service-session); we attach it at serialization time here.
// Phase is set in the filesync engine layer (Direction → uploading/
// downloading). synced/failed/blocked are NEVER set by the daemon —
// those are Desktop main-cache derivations (plan §3.3 lock).
func (s *Service) Transfers() []filesync.TransferRow {
	s.mu.Lock()
	sess := s.activeSession
	workspaceID := s.bind.WorkspaceID
	workspaceName := s.workspaceName
	s.mu.Unlock()
	if sess == nil {
		return []filesync.TransferRow{}
	}
	rows := sess.EngineTransfers()
	if rows == nil {
		return []filesync.TransferRow{}
	}
	// Inject per-row workspace identifiers so Desktop's per-project
	// progress cache can route uploading/downloading rows to the
	// matching project card. Empty workspaceID/Name means the
	// session is bound but the daemon hasn't resolved a project name
	// yet — Desktop tolerates missing fields (renders under the
	// global transfer count rather than a specific project).
	for i := range rows {
		rows[i].WorkspaceID = workspaceID
		rows[i].WorkspaceName = workspaceName
	}
	return rows
}

// WaitForUpAck registers a waiter on the live session's engine and
// returns the channel + true. When no session is active, returns
// (nil, false) so the caller can degrade (PtyAttach falls back to
// polling Transfers).
func (s *Service) WaitForUpAck(rel string) (<-chan struct{}, bool) {
	s.mu.Lock()
	sess := s.activeSession
	s.mu.Unlock()
	if sess == nil {
		return nil, false
	}
	return sess.WaitForUpAck(rel), true
}

// recordBootstrapResult lands the server's BootstrapResult into Status
// so /v1/bootstrap-status can return it. Fires from the session's
// recvLoop on every MessageBootstrapResult.
func (s *Service) recordBootstrapResult(res transport.BootstrapResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if res.Status == "pending" {
		s.bootstrapInFlight = true
	} else {
		s.bootstrapInFlight = false
	}
	if res.RepoURL != "" {
		s.status.PeerRepoURL = res.RepoURL
	}
	repoURL := res.RepoURL
	if repoURL == "" {
		repoURL = s.status.LastBootstrap.RepoURL
	}
	s.status.LastBootstrap = BootstrapState{
		Status:  res.Status,
		Error:   res.Error,
		LogTail: res.LogTail,
		Files:   res.Files,
		Bytes:   res.Bytes,
		URL:     s.status.LastBootstrap.URL,
		RepoURL: repoURL,
		At:      time.Now(),
	}
}

func (s *Service) failPendingBootstrapLocked(status, errMsg string) {
	if !s.bootstrapInFlight || s.status.LastBootstrap.Status != "pending" {
		return
	}
	s.bootstrapInFlight = false
	s.status.LastBootstrap.Status = status
	s.status.LastBootstrap.Error = errMsg
	s.status.LastBootstrap.At = time.Now()
}

// RequestBootstrap queues a bootstrap message onto the live session.
// Callers must have a connected session; if none is active, returns
// an error the HTTP layer turns into a 409.
func (s *Service) RequestBootstrap(req transport.BootstrapRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bootstrapInFlight {
		return errors.New("a bootstrap is already in flight")
	}
	sess := s.activeSession
	if sess == nil {
		return errors.New("no active sync session — wait for connection then retry")
	}
	if !s.status.Connected {
		return errors.New("sync session is not connected to server — wait for connection then retry")
	}
	if !sess.RequestBootstrap(req) {
		return errors.New("a bootstrap is already in flight")
	}
	// Stamp redacted URL + pending state so the polling UI sees
	// movement immediately instead of staring at empty status.
	s.bootstrapInFlight = true
	s.status.LastBootstrap = BootstrapState{
		Status: "pending",
		URL:    redactGitURLForStatus(req.GitURL),
		At:     time.Now(),
	}
	return nil
}

// redactGitURLForStatus mirrors session.redactGitURL but lives in syncd
// so we don't form an import cycle just for the helper. Tests aside,
// the duplication is two lines - cheaper than the refactor.
func redactGitURLForStatus(raw string) string {
	if raw == "" {
		return ""
	}
	i := strings.Index(raw, "://")
	if i < 0 {
		return raw
	}
	rest := raw[i+3:]
	at := strings.Index(rest, "@")
	if at < 0 {
		return raw
	}
	return raw[:i+3] + "***@" + rest[at+1:]
}
