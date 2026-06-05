package transport

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/encoding"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
)

const (
	ServiceName = "trans.FileService"
	TokenHeader = "x-trans-token"
	// MaxGRPCMessageSize covers large manifest/list-session envelopes.
	// File contents still move in ChunkSize pieces; this limit is about
	// startup metadata, whose JSON + encrypted []byte wrappers amplify
	// the raw manifest size over the wire.
	MaxGRPCMessageSize = 256 * 1024 * 1024
)

// ErrSessionReplaced is returned by SecureSync/Exec/Pty Recv methods
// when the server sends the in-band kick envelope. The caller should
// stop the auto-reconnect loop and surface the takeover to the user.
var ErrSessionReplaced = errors.New("session replaced by another client")

// ErrRevoked is returned by SecureSync/Exec/Pty Recv methods when the
// server's license-check supervisor observes the workspace is revoked
// or removed and best-effort notifies the client before cancelling the
// stream. Distinct from ErrSessionReplaced so the caller can show
// "license revoked / contact admin" instead of "kicked by another
// device". Same caller contract: stop the auto-reconnect loop.
//
// Security boundary status: today's filesync path only does the
// in-band notify + stream cancel — there is no server-side data-plane
// pause. Once the Syncthing backend's lease state machine lands
// (lease plan §P0b), the server SHOULD additionally pause the folder
// and remove the client device from Syncthing config before sending
// this envelope, at which point the client's receipt becomes purely
// a UX hint on top of an already-enforced boundary.
var ErrRevoked = errors.New("session revoked by license server")

// Syncthing backend control-channel manifest (see docs/syncthing-lease-plan
// §P0d and docs/syncthing-migration-plan.review §5.4). When the Syncthing
// backend is enabled, file blocks move to BEP but the following messages
// MUST remain on the Kari control stream (this gRPC FileService/Sync):
//
//   - MessageHeartbeat (15s cadence, both directions)
//   - MessageHello (handshake + per-workspace device_id exchange)
//   - MessageSessionEnd / MessageSessionEndAck (client active-session
//     graceful end + server cleanup ack — migration §3.3)
//   - MessageError carrying any of:
//     ReasonSessionReplaced, ReasonRevoked, ReasonUpgradeRequired,
//     ReasonStaleMembershipGeneration, ReasonNoCurrentMembership,
//     ReasonFolderIDMismatch, ReasonFolderIDAlgorithmMismatch,
//     ReasonSyncthingControlBlocked
//     (membership_generation carried when applicable). MUST NOT
//     collapse ReasonStaleMembershipGeneration into
//     ReasonNoCurrentMembership or vice versa — see lease plan §P0a
//     for the semantic distinction (active-holder-different vs
//     no-active-holder).
//   - MessagePresenceAck (PTY drop-image ack — migration §3.6 / §2.3 T3.6)
//   - MessageBootstrap / MessageBootstrapResult (migration §2.2)
//   - MessageProposalManifest / MessageProposalPayload / MessageProposalDelete
//     (migration §3.6)
//   - MessageForceAllow / MessageForceAllowResult (migration §2.3)
//
// Anything not listed here MAY be removed when the filesync backend is
// dropped. New control messages added by future Syncthing backend work
// must be added to this list AND to migration plan §5.4 in the same PR.

// Reason codes carried in Message.Error / Message.ServerInfo for the
// well-known server-side rejections. Kept as exported constants so the
// client side can match exactly without scraping human-readable strings.
const (
	// ReasonHandshakeRejected is the only error string we expose for any
	// handshake-time failure (missing/invalid workspace_id, key resolve
	// error, key revocation, decrypt failure, missing client_id, ...).
	// Deliberately ambiguous to avoid letting outsiders distinguish
	// "unknown workspace" from "wrong key" by probing — that gap used to
	// be a workspace enumeration oracle.
	ReasonHandshakeRejected = "handshake_rejected"

	// ReasonSessionReplaced is sent (inside the encrypted channel) to an
	// already-connected client when a newer client with the same
	// workspace_id takes over. The receiving client should stop the
	// auto-reconnect loop and surface "kicked offline" to the user.
	ReasonSessionReplaced = "session_replaced"

	// ReasonRevoked is sent when supervise() observes the license has
	// been revoked or the workspace removed mid-session. The client
	// receiving it should stop the reconnect loop and surface "license
	// revoked or workspace removed". Distinct from ReasonSessionReplaced
	// so UI can show that rather than "kicked by another device".
	//
	// Security boundary status: today's filesync path only does notify +
	// stream cancel — no server-side data-plane pause. When the
	// Syncthing backend lease state machine lands (lease plan §P0b),
	// the server MUST pair this envelope with lease.ForceClose
	// (pause folder + remove client device); at that point the client
	// receipt becomes a UX hint on an already-enforced boundary.
	ReasonRevoked = "revoked"

	// ReasonUpgradeRequired is returned to old clients that lack the
	// required Syncthing backend capabilities (see syncthing_v1 in
	// migration §2.5). Error Data carries {min_version, hint_url,
	// required_capabilities}. The client must NOT fall back to the
	// filesync backend on receiving this.
	ReasonUpgradeRequired = "upgrade_required"

	// ReasonStaleMembershipGeneration is returned when a control message
	// arrives with a membership_generation different from the current
	// one for an ACTIVE folder. Semantically: "you are not the current
	// holder — another session has taken your seat (takeover)." Caller
	// should stop reconnect; UI text should refer to "session taken
	// over by another device" or similar.
	//
	// MUST NOT be collapsed with ReasonNoCurrentMembership at the
	// dispatch layer. See lease plan §P0a + migration §4.4 / §5.4.
	ReasonStaleMembershipGeneration = "stale_membership_generation"

	// ReasonNoCurrentMembership is returned when a control message
	// arrives for a folder_id whose membership has been Revoke'd and
	// not re-allocated (tombstone state). Semantically: "this folder
	// has no current holder — you're a zombie session pinging after
	// fail-closed cleanup." Caller should stop reconnect; UI text
	// should refer to "license revoked" / "session ended" / "workspace
	// no longer attached," NOT "taken over."
	//
	// Distinct from ReasonStaleMembershipGeneration: that says "you
	// are not the current holder"; this says "there IS no current
	// holder." UI text and operator messaging must differ; wire
	// reasons MUST stay distinct. See lease plan §P0a "Membership
	// tombstone (Revoke 后)" + migration §5.4.
	ReasonNoCurrentMembership = "no_current_membership"

	// ReasonFolderIDMismatch is returned when the client's hello
	// folder_id has the same algorithm version prefix as the server's
	// (e.g. both "kari1_…") but the slug/hash differs — implementation
	// bug or workspace_id confusion. Hard reject; no membership created.
	// See migration §2.1 + §2.5 T0.4.
	ReasonFolderIDMismatch = "folder_id_mismatch"

	// ReasonFolderIDAlgorithmMismatch is returned when the folder_id
	// algorithm version prefix differs (e.g. client sent "kari2_…" but
	// this server only knows "kari1_…", or vice versa). Error Data
	// carries {server_version, server_supported} so the client can
	// decide whether to upgrade or roll back. No membership created.
	// See migration §2.1 + §2.5 T0.4.
	ReasonFolderIDAlgorithmMismatch = "folder_id_algorithm_mismatch"

	// ReasonSyncthingControlBlocked is returned when the server has
	// entered the cold-safety blocked terminal state (Option A): new
	// membership-creating Syncthing handshakes are refused until an
	// operator triggers retry via mgmt API. Error Data carries
	// {cold_safety_failed: N}. Cleanup messages on existing memberships
	// (SessionEnd, server-side Revoked) are still processed; Heartbeat
	// is read but does NOT refresh lease. See migration §4.5 + lease
	// plan §3.4.
	ReasonSyncthingControlBlocked = "syncthing_control_blocked"
)

func init() {
	encoding.RegisterCodec(JsonCodec{})
}

type MessageType string

const (
	// CapabilityPtyCountUpdate means the peer can receive
	// MessagePtyCountUpdate on the sync stream. Older daemons treated
	// unknown sync messages as fatal, so servers must gate this message
	// behind an explicit capability instead of sending it unconditionally.
	CapabilityPtyCountUpdate = "pty_count_update"
	// CapabilityLocalExec means the peer is a desktop daemon that can
	// receive MessageLocalExecRequest and run argv-style commands on the
	// user's machine via the bundled exec policy. Only daemons with a
	// runner wired in advertise this — old daemons never see exec
	// requests, and Windows daemons without Job Object cancel support
	// must NOT advertise it (half-support would leak orphan processes).
	CapabilityLocalExec = "local_exec_v1"
	// CapabilitySyncthingV1 means the peer understands the v1 Syncthing
	// backend control protocol: MessageSessionEnd / SessionEndAck, the
	// new reason codes (Revoked, FolderID*, SyncthingControlBlocked,
	// StaleMembershipGeneration), per-attach client_instance_id, and
	// the lock-pending-free same-machine takeover model. Old daemons
	// that lack this capability MUST be rejected with ReasonUpgradeRequired
	// when attaching a Syncthing-backed workspace — they must not be
	// allowed to fall back to filesync against a workspace that has been
	// promoted to the Syncthing backend.
	//
	// Currently a placeholder; gating logic lands in PR1.1c.
	// See migration plan §2.5 and §0.3.
	CapabilitySyncthingV1 = "syncthing_v1"
)

const (
	MessageHello       MessageType = "hello"
	MessageFileMeta    MessageType = "file_meta"
	MessageFileChunk   MessageType = "file_chunk"
	MessageFileDone    MessageType = "file_done"
	MessageDelete      MessageType = "delete"
	MessageHeartbeat   MessageType = "heartbeat"
	MessageCommand     MessageType = "command"
	MessageCommandData MessageType = "command_data"
	MessageCommandDone MessageType = "command_done"
	MessagePtyStart    MessageType = "pty_start"
	MessagePtyInput    MessageType = "pty_input"
	MessagePtyOutput   MessageType = "pty_output"
	MessagePtyResize   MessageType = "pty_resize"
	MessagePtyExit     MessageType = "pty_exit"
	MessageTextOp      MessageType = "text_op"
	MessageFileStatus  MessageType = "file_status"
	MessageError       MessageType = "error"
	// MessageManifest carries a JSON-encoded []filesync.FileInfo in
	// Data — both live files (Deleted=false) and tombstones
	// (Deleted=true, Version=tombstone-time). Sent once per session
	// right after Hello so each side can diff against its own state
	// and push only what the peer is missing. Peers that don't
	// understand this type (old daemon binaries) won't send one back,
	// which the sender detects via a 2s fallback timer and degrades
	// to legacy SendSnapshot.
	MessageManifest MessageType = "manifest"
	// MessageBootstrap is sent client → server when the operator wants
	// the server to populate an empty workspace by running git clone.
	// Data carries a JSON-encoded BootstrapRequest. The server replies
	// (synchronously, may take minutes) with MessageBootstrapResult.
	// Auth is implicit: the message rides inside the already
	// AES-encrypted sync stream, which the server only opens after
	// validating the workspace's activation_code-derived key.
	MessageBootstrap       MessageType = "bootstrap"
	MessageBootstrapResult MessageType = "bootstrap_result"
	// MessageListSessions is sent client → server when the VS Code
	// extension wants the list of past Claude / Codex CLI sessions on
	// the server (so the user can click one to resume). Data carries a
	// JSON-encoded ListSessionsRequest. Server replies with
	// MessageListSessionsResult. Same auth-by-encrypted-envelope as
	// MessageBootstrap.
	MessageListSessions       MessageType = "list_sessions"
	MessageListSessionsResult MessageType = "list_sessions_result"
	// MessageForceAllow is sent client -> server when the operator
	// explicitly right-clicks a path and asks Kari to sync it despite
	// .gitignore. Data carries ForceAllowRequest. The receiver records
	// the paths in its local allowlist; ordinary file_meta/delete
	// messages do not grant this permission.
	MessageForceAllow       MessageType = "force_allow"
	MessageForceAllowResult MessageType = "force_allow_result"
	// MessagePtyCountUpdate is sent server -> client on the sync stream
	// whenever the number of live PTY sessions for a workspace changes.
	// The daemon exposes this as /v1/status.pty_count so the VS Code
	// extension can rotate/stop the local reverse proxy only after the
	// workspace's last PTY has exited.
	MessagePtyCountUpdate MessageType = "pty_count_update"
	// MessageLocalExecRequest is sent server -> daemon on the sync stream
	// when an MCP-bridge tool call wants to run a command on the user's
	// desktop. Data carries a JSON-encoded LocalExecRequest. The daemon
	// matches against the local exec policy (default deny) and replies
	// with zero or more MessageLocalExecOutput envelopes plus a final
	// MessageLocalExecDone keyed by RequestID. Gated by
	// CapabilityLocalExec so old daemons never see this type.
	MessageLocalExecRequest MessageType = "local_exec_request"
	// MessageLocalExecOutput is sent daemon -> server with a chunk of
	// stdout or stderr from a running local exec. Data carries a
	// JSON-encoded LocalExecOutput.
	MessageLocalExecOutput MessageType = "local_exec_output"
	// MessageLocalExecDone is sent daemon -> server when a local exec
	// terminates (success, failure, denied, or truncated). Data carries
	// a JSON-encoded LocalExecDone. After Done the server completes any
	// outstanding waiter keyed on RequestID and removes it from the map.
	MessageLocalExecDone MessageType = "local_exec_done"
	// MessageLocalExecCancel is sent server -> daemon to abort an
	// in-flight local exec — either because the MCP bridge disconnected
	// without a Done, the requesting context expired, or the user
	// revoked the run. Data carries a JSON-encoded LocalExecCancel.
	// The daemon kills the matching process group (POSIX) or job
	// (Windows); a MessageLocalExecDone still follows so accounting
	// stays consistent.
	MessageLocalExecCancel MessageType = "local_exec_cancel"

	// MessageCancelDownload is sent recipient -> sender to abort an
	// in-flight download for a specific workspace. The sender stops
	// streaming any further file_meta / chunk / file_done for that
	// workspace's outbound queue and cancels any sendFile already in
	// flight at the next chunk boundary. Data carries a JSON-encoded
	// CancelDownloadPayload.
	//
	// Cancellation is session-local AND STICKY: the outbound stays
	// paused until an explicit MessageResumeDownload (or a fresh
	// MessageManifest exchange — recipient's retry path may trigger
	// either, depending on whether the session got rebuilt).
	//
	// Idempotent — multiple cancels in flight produce one "everything
	// stopped" outcome.
	//
	// No capability gate. Paired-upgrade only: trans daemon + trans
	// server must be the same build. Old peers fall through recvLoop's
	// default case which returns "unexpected sync message type" and
	// TEARS THE SESSION DOWN. This is intentional fail-loud behavior
	// for a paired upgrade gone wrong — never silently drop.
	MessageCancelDownload MessageType = "cancel_download"
	// MessageResumeDownload is sent recipient -> sender to re-enable
	// outbound after a MessageCancelDownload. Required because the
	// recipient's "retry download" UX path is downloadProject →
	// bindProjectIfPossible → postSyncTask, and when the same
	// workspace is already bound, none of those steps restart the
	// session or trigger a fresh manifest exchange — without an
	// explicit resume signal, the sender would stay outbound-stopped
	// forever and the retry would silently do nothing.
	//
	// Idempotent — resume on a non-stopped session is a no-op. Data
	// carries a JSON-encoded ResumeDownloadPayload (workspace_name
	// for diagnostics).
	//
	// Same paired-upgrade requirement as MessageCancelDownload.
	MessageResumeDownload MessageType = "resume_download"

	// ----- Syncthing backend control-plane message types -----
	// The constants below are placeholders introduced in PR1.1a as part
	// of the wire-format gate. They are NOT emitted or handled by the
	// current code path. Each will be wired up in a later PR (referenced
	// by §xx in migration plan) and is listed in the file-level control
	// channel manifest at the top of this file.

	// MessageSessionEnd is sent client -> server when the local active
	// workspace session ends gracefully — either because the last local
	// consumer (VS Code window / CLI attach) detached past the 30s
	// session_stop_grace, or because a same-machine yield request came
	// in. Data carries {folder_id, membership_generation, reason}, where
	// reason ∈ {"last_consumer_detached", "replaced_by_local_session"}.
	// Server response is MessageSessionEndAck after pause+remove device
	// has been written to Syncthing config and the membership store has
	// been cleared. See migration §3.3 step 4.
	MessageSessionEnd MessageType = "session_end"

	// MessageSessionEndAck is sent server -> client after the server has
	// completed PUT folder paused=true + devices remove + explicit
	// membership clear in response to a SessionEnd. Client must wait for
	// this ack (with 500ms timeout) before stopping its local sidecar
	// and releasing the owner lock, to avoid sidecar-stop-vs-PUT race.
	// See migration §3.3 step 4 + lease plan §3.2.
	MessageSessionEndAck MessageType = "session_end_ack"

	// MessagePresenceAck is sent server -> client to confirm a file
	// produced on this client has been observed by the server-side
	// Syncthing scanner. Today filesync's WaitForUpAck plays this role
	// in-stream; under the Syncthing backend, server reconciler watches
	// the target folder for the path's appearance and emits this ack
	// over the Kari control channel. Used by PTY drop-image upload so
	// PtyAttach does not return success until the server actually has
	// the file. See migration §2.3 T3.6 + §3.6.
	MessagePresenceAck MessageType = "presence_ack"

	// MessageProposalManifest is sent server -> client by the Kari-owned
	// proposal producer when it has read a complete .kari-proposals/<id>/
	// manifest.json on the server side. Data carries the manifest plus
	// the list of payload files in this batch. The proposal flow does
	// not transit BEP — .kari-proposals/** is .stignored on both ends.
	// See migration §3.6.
	MessageProposalManifest MessageType = "proposal_manifest"

	// MessageProposalPayload is sent server -> client carrying one
	// individual proposal payload file body (rel path + bytes + hash),
	// grouped under a proposal_id + batch_id with its MessageProposalManifest.
	// See migration §3.6.
	MessageProposalPayload MessageType = "proposal_payload"

	// MessageProposalDelete is sent server -> client when a proposal is
	// retracted (AI rolled back, or operator dropped it). Client routes
	// to ReviewManager.OnProposalDelete and removes .kari/pending/<id>/.
	// See migration §3.6.
	MessageProposalDelete MessageType = "proposal_delete"
)

type PtyCountUpdate struct {
	WorkspaceID string `json:"workspace_id,omitempty"`
	PtyCount    int    `json:"pty_count"`
}

// LocalExecRequest is the JSON shape carried in Message.Data of a
// MessageLocalExecRequest. Argv is parsed by the daemon as program +
// args — there is no shell interpretation, no globbing, no env
// substitution. CWD, if set, must be a relative path under the
// workspace root; the daemon EvalSymlinks-normalises it and rejects
// anything that escapes. EnvOverlay is filtered against the policy's
// allow_env whitelist; unknown names are dropped, and a hard deny list
// (LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*, PATH unless allow_path_prepend)
// is enforced regardless of policy. TimeoutSeconds is capped by the
// policy's max_timeout_seconds; zero means use the policy default.
type LocalExecRequest struct {
	RequestID      string            `json:"request_id"`
	Argv           []string          `json:"argv"`
	CWD            string            `json:"cwd,omitempty"`
	EnvOverlay     map[string]string `json:"env_overlay,omitempty"`
	TimeoutSeconds int               `json:"timeout_seconds,omitempty"`
}

// LocalExecOutput is the JSON shape carried in Message.Data of a
// MessageLocalExecOutput. Stream is "stdout" or "stderr"; Seq is a
// monotonically-increasing per-request counter so the server can
// reorder if frames arrive interleaved (currently the daemon sends in
// order, but the seq lets receivers detect gaps from a future
// out-of-order path). Data is the raw bytes — not UTF-8-validated;
// MCP layer is responsible for safe rendering.
type LocalExecOutput struct {
	RequestID string `json:"request_id"`
	Stream    string `json:"stream"`
	Data      []byte `json:"data"`
	Seq       int64  `json:"seq"`
}

// LocalExecDone is the JSON shape carried in Message.Data of a
// MessageLocalExecDone. Exactly one Done follows each Request (even
// for denied, errored, or cancelled runs). DeniedReason is set when
// the policy rejected the argv before spawning. Error captures
// spawn-time or runtime failures other than non-zero exit (which is
// signalled via ExitCode). Truncated + TruncatedReason mark a run
// whose output exceeded the per-request cap; the process was allowed
// to continue but further chunks were dropped. OutputBytes is the
// total stdout+stderr byte count actually delivered (post-truncation).
type LocalExecDone struct {
	RequestID       string `json:"request_id"`
	ExitCode        int    `json:"exit_code"`
	DurationMS      int64  `json:"duration_ms"`
	DeniedReason    string `json:"denied_reason,omitempty"`
	Error           string `json:"error,omitempty"`
	Truncated       bool   `json:"truncated,omitempty"`
	TruncatedReason string `json:"truncated_reason,omitempty"`
	OutputBytes     int64  `json:"output_bytes,omitempty"`
}

// LocalExecCancel is the JSON shape carried in Message.Data of a
// MessageLocalExecCancel. Reason is opaque metadata for the daemon
// audit log (e.g. "bridge_disconnected", "ctx_canceled", "user_revoked").
type LocalExecCancel struct {
	RequestID string `json:"request_id"`
	Reason    string `json:"reason,omitempty"`
}

// CancelDownloadPayload is the data body of MessageCancelDownload.
// WorkspaceName is informational — Session is already 1:1 with a
// workspace bind, so the receiving side cancels the entire session's
// outbound regardless. Carrying the name lets the recipient's audit
// log show WHICH workspace the user cancelled, and lets future
// session-multiplexing implementations (one stream per multiple
// workspaces) target the right one.
type CancelDownloadPayload struct {
	WorkspaceName string `json:"workspace_name,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

// ResumeDownloadPayload is the data body of MessageResumeDownload.
// WorkspaceName is informational (same rationale as
// CancelDownloadPayload). No reason field — resume is the user
// explicitly retrying, which is its own self-documenting trigger.
type ResumeDownloadPayload struct {
	WorkspaceName string `json:"workspace_name,omitempty"`
}

// Reason codes used in LocalExecDone.DeniedReason and TruncatedReason.
// Kept as exported constants so call sites match without scraping
// human-readable strings.
const (
	LocalExecDeniedPolicyMissing  = "policy_load_error"
	LocalExecDeniedNotAllowed     = "policy_no_match"
	LocalExecDeniedPolicyDenied   = "policy_denied"
	LocalExecDeniedBadCWD         = "cwd_escape"
	LocalExecDeniedBadArgv        = "argv_invalid"
	LocalExecDeniedEnvRejected    = "env_rejected"
	LocalExecTruncatedMaxBytes    = "max_bytes"
	LocalExecTruncatedRateLimit   = "rate_limit"
	LocalExecCancelBridgeGone     = "bridge_disconnected"
	LocalExecCancelContextExpired = "context_canceled"
)

func HasCapability(msg *Message, capability string) bool {
	if msg == nil || capability == "" {
		return false
	}
	for _, item := range msg.Capabilities {
		if item == capability {
			return true
		}
	}
	return false
}

type ForceAllowEntry struct {
	Path string `json:"path"`
	Dir  bool   `json:"dir,omitempty"`
}

type ForceAllowRequest struct {
	Entries []ForceAllowEntry `json:"entries"`
}

type ForceAllowResult struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Entries int    `json:"entries,omitempty"`
}

// ListSessionsRequest is the JSON shape carried in Message.Data of a
// MessageListSessions. Sources may name a subset of {"claude",
// "claude-one", "codex"}; empty/nil means all three. Anything else
// is silently dropped server-side rather than failing the request —
// older clients sending an unknown source should still get back what
// they understand.
type ListSessionsRequest struct {
	Sources      []string `json:"sources,omitempty"`
	ForceRefresh bool     `json:"force_refresh,omitempty"`
}

// SessionEntry is one row in the history TreeView. Project is the
// workspace/project display name when the scanner can derive it from
// a filtered workspace root or the CLI session cwd. ModTime is unix
// nanos so the client doesn't need timezone fudging.
type SessionEntry struct {
	ID      string `json:"id"`
	Project string `json:"project,omitempty"`
	Title   string `json:"title,omitempty"`
	ModTime int64  `json:"mtime"`
}

// SessionSource groups entries by where they live. Error captures
// per-source failures (e.g. ~/.claude-one/ doesn't exist on this
// server) so the client can render a partial result rather than
// the whole list failing on one missing dir.
type SessionSource struct {
	Kind     string         `json:"kind"`
	Sessions []SessionEntry `json:"sessions"`
	Error    string         `json:"error,omitempty"`
}

// ListSessionsResult is the JSON shape carried in Message.Data of a
// MessageListSessionsResult.
type ListSessionsResult struct {
	Sources []SessionSource `json:"sources"`
}

// BootstrapRequest is the JSON shape carried in Message.Data of a
// MessageBootstrap. URL has username:password already embedded by the
// daemon side — the operator types them separately in the UI but the
// daemon assembles `https://user:pass@host/path` before sending so the
// server doesn't have to know about user/pass as separate fields.
type BootstrapRequest struct {
	GitURL  string `json:"git_url"`
	Flatten bool   `json:"flatten,omitempty"`
}

// BootstrapResult is the JSON shape carried in Message.Data of a
// MessageBootstrapResult. Status is "pending" for progress updates,
// "ok" on success, or a short code like "dir_not_empty",
// "git_project_exists", "clone_failed", "flatten_failed". Error is a
// human-readable message; LogTail is the last few lines of git's
// stdout/stderr with the credential portion of the URL redacted.
// RepoURL is the redacted (no credentials) git remote URL that was
// cloned — the daemon uses it to verify the local workspace cloned
// from the same repository.
type BootstrapResult struct {
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	LogTail string `json:"log_tail,omitempty"`
	Files   int    `json:"files,omitempty"`
	Bytes   int64  `json:"bytes,omitempty"`
	RepoURL string `json:"repo_url,omitempty"`
}

// FileStatus values carried in Message.Stream when Type=file_status.
const (
	FileStatusSyncing = "syncing"
	FileStatusSynced  = "synced"
	FileStatusDirty   = "dirty"
	FileStatusError   = "error"
)

type MCPSessionInfo struct {
	TerminalID     string `json:"terminal_id,omitempty"`
	ContextPath    string `json:"context_path,omitempty"`
	MCPConfigPath  string `json:"mcp_config_path,omitempty"`
	MCPCommandPath string `json:"mcp_command_path,omitempty"`
}

type Message struct {
	Type       MessageType `json:"type"`
	Origin     string      `json:"origin,omitempty"`
	Path       string      `json:"path,omitempty"`
	Size       int64       `json:"size,omitempty"`
	ModTime    int64       `json:"mod_time,omitempty"`
	Hash       string      `json:"hash,omitempty"`
	Version    int64       `json:"version,omitempty"`
	ChunkIndex int64       `json:"chunk_index,omitempty"`
	Data       []byte      `json:"data,omitempty"`
	// Offset is the byte offset within the target file at which this
	// chunk stream resumes. Set on MessageFileMeta when the peer's
	// manifest advertised a matching PartialBytes/PartialEtag — the
	// sender Seeks to Offset before reading, and the receiver opens
	// the .trans-tmp in append mode after replaying the existing bytes
	// into its running sha256. Zero means start-of-file (old client
	// default, fully back-compatible).
	Offset    int64  `json:"offset,omitempty"`
	CommandID string `json:"command_id,omitempty"`
	Command   string `json:"command,omitempty"`
	WorkDir   string `json:"work_dir,omitempty"`
	Stream    string `json:"stream,omitempty"`
	ExitCode  int    `json:"exit_code,omitempty"`
	Error     string `json:"error,omitempty"`
	Rows      uint16 `json:"rows,omitempty"`
	Cols      uint16 `json:"cols,omitempty"`
	// Model selects which CLI to spawn behind the sandbox on
	// MessagePtyStart: "" / "shell" → plain shell, "claude" → Claude
	// Code, "codex" → Codex CLI. Server-side aisession.ParseMode does
	// the lookup; unknown values fall back to shell to keep older
	// clients (pre-flag) working.
	Model string `json:"model,omitempty"`
	// StartupKind is a desktop-side hint for shell PTYs where the UI
	// auto-types a CLI command after the PTY handshake. It must not
	// affect runner selection; Model remains the only spawn selector.
	StartupKind string `json:"startup_kind,omitempty"`
	// Text op payload for CRDT/OT-capable clients.
	DocID         string          `json:"doc_id,omitempty"`
	BaseSeq       int64           `json:"base_seq,omitempty"`
	OpSeq         int64           `json:"op_seq,omitempty"`
	OpType        string          `json:"op_type,omitempty"` // insert | delete | retain
	OpPos         int             `json:"op_pos,omitempty"`
	OpLen         int             `json:"op_len,omitempty"`
	OpText        string          `json:"op_text,omitempty"`
	ClientID      string          `json:"client_id,omitempty"`
	WorkspaceID   string          `json:"workspace_id,omitempty"`
	WorkspaceName string          `json:"workspace_name,omitempty"`
	Capabilities  []string        `json:"capabilities,omitempty"`
	ServerInfo    string          `json:"server_info,omitempty"`
	PtyCount      int             `json:"pty_count,omitempty"`
	MCPSession    *MCPSessionInfo `json:"mcp_session,omitempty"`
	// AttachID is the client-generated stable identifier for a single
	// PTY session. Sent on MessagePtyStart so the server can park the
	// shell behind an AttachID-keyed registry entry, surviving network
	// drops: a reconnecting client sends the same AttachID and the
	// server re-attaches the existing shell instead of forking a new
	// one. Empty AttachID falls back to the legacy "no resume" path
	// (every PtyStart spawns a fresh shell, every disconnect kills it).
	AttachID string `json:"attach_id,omitempty"`
	// Seq carries the absolute byte offset within a PTY's lifetime
	// output stream. Two roles:
	//   - On MessagePtyStart (client→server): "I last received bytes
	//     0..Seq, replay from Seq onwards." Zero means "start me from
	//     the latest available frame in the server's ring buffer."
	//   - On MessagePtyOutput (server→client): "this chunk's first
	//     byte is at absolute offset Seq." Client uses it to track
	//     lastSeq for the next reconnect.
	//
	// Old peers don't set this field; both sides treat Seq=0 as "no
	// info" rather than a real zero offset (we use the absence/presence
	// of AttachID as the resume gate).
	Seq int64 `json:"seq,omitempty"`
	// UseContainer 是 server-side 决定的:trans-server Pty handler
	// 收到 MessagePtyStart 后,lookup license 的 FeatureContainerShell
	// 标志,如果是 true 就把这个字段也置 true 然后丢给下游 PTY runner。
	// 客户端可能也设(但服务器会覆盖),所以这字段的"真值"权威是
	// server 注入的那一刻。runner 看到 true → docker exec 分支;
	// false → 走原 host shell 路径。
	UseContainer bool `json:"use_container,omitempty"`
	// ContainerName 是 server-side 注入的 docker container name(post-
	// refactor:`kari-ct-<id>` 从 mgmt containers 表取得;legacy: 空,
	// runner fallback 到 ContainerName(wsid) 推导)。配合 UseContainer
	// 用 — UseContainer=true 时 runner 优先用这个名字 docker exec 进去。
	ContainerName string `json:"container_name,omitempty"`
	// LocalSSH* carries client-side reverse-proxy connection details
	// from kari CLI to trans-server. The server only passes these into
	// docker exec env when UseContainer=true so in-container Claude /
	// Codex can SSH back to the user's machine.
	LocalSSHHost string `json:"local_ssh_host,omitempty"`
	LocalSSHPort int    `json:"local_ssh_port,omitempty"`
	LocalSSHUser string `json:"local_ssh_user,omitempty"`
	LocalSSHKey  string `json:"local_ssh_key,omitempty"`
	// RepoURL travels on MessageManifest. It's the git remote origin URL
	// the sender's workspace reports (from .git/config, or repo-lock.json
	// if no .git yet). Used by the recipient to detect repo-mismatch
	// before mass-pushing local files at a peer that bootstrapped a
	// different repo. Old peers omit it; receiver falls back to "assume
	// matching" rather than block on missing data.
	RepoURL string `json:"repo_url,omitempty"`

	// ----- Syncthing backend additive hello / control fields -----
	//
	// All fields below are additive and omitempty. They land in PR1.1c
	// purely as schema scaffolding; no current code path emits or reads
	// them. Policy gating (e.g. rejecting hello with missing FolderID on
	// a syncthing-backed workspace) lands in a later PR alongside the
	// hello capability check. Old clients omit every one of these and
	// today's behavior is unchanged.
	//
	// See migration plan §2.5 (hello schema) and lease plan §P0a
	// (membership_generation handling) for the wire spec these mirror.
	// client_capabilities continues to use the existing Capabilities
	// []string field above (CapabilitySyncthingV1 is the v1 token); no
	// duplicate is introduced here.

	// ClientVersion is the calling client's semantic version string
	// (e.g. "0.13.2"). Used by server to decide if the client meets
	// min_syncthing_client_version when attaching a syncthing-backed
	// workspace. Empty for daemons that predate this field.
	ClientVersion string `json:"client_version,omitempty"`

	// SyncBackend is set by the server in the hello-ack to tell the
	// client which backend this workspace is on ("filesync" or
	// "syncthing"). Clients use this to decide whether to start a
	// Syncthing sidecar locally and whether the additional schema
	// fields below are expected.
	SyncBackend string `json:"sync_backend,omitempty"`

	// FolderID is the URL-safe opaque token derived from workspace_id
	// per migration §2.1 (kari1_<slug>__<hash>). Client computes it
	// locally before sending hello; server returns the same value in
	// hello-ack for sanity check. Mismatch surfaces as
	// ReasonFolderIDMismatch / ReasonFolderIDAlgorithmMismatch.
	FolderID string `json:"folder_id,omitempty"`

	// ClientSyncthingDeviceID is the device certificate fingerprint of
	// the client's per-workspace Syncthing sidecar. Sent in hello so
	// the server can add it to folder.devices when accepting takeover.
	// Empty when the client hasn't started a sidecar (e.g. filesync
	// backend, or pre-sidecar mid-bootstrap window).
	ClientSyncthingDeviceID string `json:"client_syncthing_device_id,omitempty"`

	// ClientInstanceID is the per-active-workspace-session UUID
	// (migration §2.5). NOT daemon lifetime — kari-syncd regenerates
	// this each time the local-consumer refcount transitions 0→1.
	// Lets the server distinguish "same daemon, new session" from
	// "same daemon, same session reconnecting after a blip", which
	// matters for SessionEnd-ack-timeout-then-immediate-reattach
	// (migration §4.4 step 7).
	ClientInstanceID string `json:"client_instance_id,omitempty"`

	// MembershipGeneration is the server-issued monotonic counter for
	// the current (folder_id, client) membership tuple (lease plan
	// §P0a). Server allocates it during hello-ack and stamps it on
	// every subsequent control message. Clients never originate this
	// value — they only echo back whatever server assigned. (Future
	// diagnostics fields like last_seen_membership_generation, if
	// added, would land here; today there are none.)
	MembershipGeneration uint64 `json:"membership_generation,omitempty"`

	// FromMembershipGeneration / ToMembershipGeneration carry the
	// (old, new) tuple on takeover-style control messages — primarily
	// ReasonSessionReplaced — so the receiving client can verify that
	// the kick is for the membership it still holds (rejects stale
	// replays). Both omitempty: today's filesync session_replaced path
	// doesn't carry them, and the lease state machine that will read
	// them lands in a later PR.
	FromMembershipGeneration uint64 `json:"from_membership_generation,omitempty"`
	ToMembershipGeneration   uint64 `json:"to_membership_generation,omitempty"`
}

type SecureMessage struct {
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
}

// KeyResolver lets the server-side handshake helpers turn a `workspace_id`
// from an incoming hello envelope into the 32-byte shared key for that
// workspace. Implementations typically wrap an internal/registry instance,
// re-deriving the key as SHA-256(activation_code).
type KeyResolver interface {
	Resolve(ctx context.Context, workspaceID string) (key []byte, err error)
}

type FileServiceServer interface {
	Sync(FileService_SyncServer) error
	Exec(FileService_ExecServer) error
	Pty(FileService_PtyServer) error
}

type FileServiceClient interface {
	Sync(ctx context.Context, opts ...grpc.CallOption) (FileService_SyncClient, error)
	Exec(ctx context.Context, opts ...grpc.CallOption) (FileService_ExecClient, error)
	Pty(ctx context.Context, opts ...grpc.CallOption) (FileService_PtyClient, error)
}

type Client struct {
	cc grpc.ClientConnInterface
}

func NewClient(cc grpc.ClientConnInterface) FileServiceClient {
	return &Client{cc: cc}
}

func Dial(ctx context.Context, addr string) (*grpc.ClientConn, error) {
	// Mirror the server-side bump (cmd/server/main.go) so manifest
	// exchanges on big workspaces don't trip the 4 MB default message
	// ceiling. Send is bumped too because the daemon can originate the
	// same large manifest envelope.
	//
	// HTTP/2 keepalive lets us notice a dead transport (NAT/proxy
	// silently dropped the TCP) within ~Time+Timeout instead of
	// waiting for the next application-level Send to bounce — the
	// difference between a 30s reconnect and a several-minute hang.
	// PermitWithoutStream is on so the ping fires even between RPCs.
	return grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(MaxGRPCMessageSize),
			grpc.MaxCallSendMsgSize(MaxGRPCMessageSize),
		),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time: 30 * time.Second,
			// Timeout=5s (was 10s) tightens silent-peer detection from
			// ~40s to ~35s, leaving more headroom under the Syncthing
			// backend's 60s lease grace before the 105s absolute pause
			// trigger. Must stay in sync with the server-side keepalive
			// in cmd/server/main.go. See docs/syncthing-lease-plan
			// §P0c (Path A).
			Timeout:             5 * time.Second,
			PermitWithoutStream: true,
		}),
	)
}

func ContextWithToken(ctx context.Context, token string) context.Context {
	return metadata.AppendToOutgoingContext(ctx, TokenHeader, token)
}

func TokenFromContext(ctx context.Context) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	values := md.Get(TokenHeader)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func RegisterFileServiceServer(s grpc.ServiceRegistrar, srv FileServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: ServiceName,
		HandlerType: (*FileServiceServer)(nil),
		Streams: []grpc.StreamDesc{
			{
				StreamName:    "Sync",
				Handler:       syncHandler,
				ServerStreams: true,
				ClientStreams: true,
			},
			{
				StreamName:    "Exec",
				Handler:       execHandler,
				ServerStreams: true,
				ClientStreams: true,
			},
			{
				StreamName:    "Pty",
				Handler:       ptyHandler,
				ServerStreams: true,
				ClientStreams: true,
			},
		},
	}, srv)
}

func (c *Client) Sync(ctx context.Context, opts ...grpc.CallOption) (FileService_SyncClient, error) {
	stream, err := c.cc.NewStream(ctx, &grpc.StreamDesc{
		StreamName:    "Sync",
		ServerStreams: true,
		ClientStreams: true,
	}, "/"+ServiceName+"/Sync", append(opts, grpc.ForceCodec(JsonCodec{}))...)
	if err != nil {
		return nil, err
	}
	return &syncClient{ClientStream: stream}, nil
}

func (c *Client) Exec(ctx context.Context, opts ...grpc.CallOption) (FileService_ExecClient, error) {
	stream, err := c.cc.NewStream(ctx, &grpc.StreamDesc{
		StreamName:    "Exec",
		ServerStreams: true,
		ClientStreams: true,
	}, "/"+ServiceName+"/Exec", append(opts, grpc.ForceCodec(JsonCodec{}))...)
	if err != nil {
		return nil, err
	}
	return &execClient{ClientStream: stream}, nil
}

func (c *Client) Pty(ctx context.Context, opts ...grpc.CallOption) (FileService_PtyClient, error) {
	stream, err := c.cc.NewStream(ctx, &grpc.StreamDesc{
		StreamName:    "Pty",
		ServerStreams: true,
		ClientStreams: true,
	}, "/"+ServiceName+"/Pty", append(opts, grpc.ForceCodec(JsonCodec{}))...)
	if err != nil {
		return nil, err
	}
	return &ptyClient{ClientStream: stream}, nil
}

func syncHandler(srv any, stream grpc.ServerStream) error {
	return srv.(FileServiceServer).Sync(&syncServer{ServerStream: stream})
}

func execHandler(srv any, stream grpc.ServerStream) error {
	return srv.(FileServiceServer).Exec(&execServer{ServerStream: stream})
}

func ptyHandler(srv any, stream grpc.ServerStream) error {
	return srv.(FileServiceServer).Pty(&ptyServer{ServerStream: stream})
}

type FileService_SyncClient interface {
	Send(*Message) error
	Recv() (*Message, error)
	grpc.ClientStream
}

type FileService_SyncServer interface {
	Send(*Message) error
	Recv() (*Message, error)
	grpc.ServerStream
}

type FileService_ExecClient interface {
	Send(*Message) error
	Recv() (*Message, error)
	CloseSend() error
	grpc.ClientStream
}

type FileService_ExecServer interface {
	Send(*Message) error
	Recv() (*Message, error)
	grpc.ServerStream
}

type FileService_PtyClient interface {
	Send(*Message) error
	Recv() (*Message, error)
	CloseSend() error
	grpc.ClientStream
}

type FileService_PtyServer interface {
	Send(*Message) error
	Recv() (*Message, error)
	grpc.ServerStream
}

type syncClient struct {
	grpc.ClientStream
}

func (c *syncClient) Send(msg *Message) error {
	return c.ClientStream.SendMsg(msg)
}

func (c *syncClient) Recv() (*Message, error) {
	msg := new(Message)
	if err := c.ClientStream.RecvMsg(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

type execClient struct {
	grpc.ClientStream
}

func (c *execClient) Send(msg *Message) error {
	return c.ClientStream.SendMsg(msg)
}

func (c *execClient) Recv() (*Message, error) {
	msg := new(Message)
	if err := c.ClientStream.RecvMsg(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

type ptyClient struct {
	grpc.ClientStream
}

func (c *ptyClient) Send(msg *Message) error {
	return c.ClientStream.SendMsg(msg)
}

func (c *ptyClient) Recv() (*Message, error) {
	msg := new(Message)
	if err := c.ClientStream.RecvMsg(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

type syncServer struct {
	grpc.ServerStream
}

func (s *syncServer) Send(msg *Message) error {
	return s.ServerStream.SendMsg(msg)
}

func (s *syncServer) Recv() (*Message, error) {
	msg := new(Message)
	if err := s.ServerStream.RecvMsg(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

type execServer struct {
	grpc.ServerStream
}

func (s *execServer) Send(msg *Message) error {
	return s.ServerStream.SendMsg(msg)
}

func (s *execServer) Recv() (*Message, error) {
	msg := new(Message)
	if err := s.ServerStream.RecvMsg(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

type ptyServer struct {
	grpc.ServerStream
}

func (s *ptyServer) Send(msg *Message) error {
	return s.ServerStream.SendMsg(msg)
}

func (s *ptyServer) Recv() (*Message, error) {
	msg := new(Message)
	if err := s.ServerStream.RecvMsg(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

// JsonCodec is exported so the server can use grpc.ForceServerCodec to make
// JSON the default for any incoming stream regardless of the client's
// content-subtype. Tonic on the Rust side does not let us set
// `content-type: application/grpc+json` per-request (it hardcodes
// `application/grpc`), so the server must force JSON instead of falling back
// to the protobuf codec.
type JsonCodec struct{}

func (JsonCodec) Name() string {
	return "json"
}

func (JsonCodec) Marshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

func (JsonCodec) Unmarshal(data []byte, v any) error {
	if len(data) == 0 {
		return io.ErrUnexpectedEOF
	}
	if v == nil {
		return errors.New("nil unmarshal target")
	}
	return json.Unmarshal(data, v)
}

// sendMu on each Secure* wrapper serialises ALL outbound traffic on the
// wrapped gRPC stream. gRPC's SendMsg is not safe for concurrent callers,
// and the sync session has several concurrent senders by design:
// sendLoop's heartbeat + file pushes, recvLoop's EmitStatus echoes,
// session.Run init's hello/manifest, fallbackTimer.AfterFunc's
// SendSnapshot. The server side additionally has sessionRegistry.register
// (cmd/server/sessions.go) firing kick envelopes onto Exec/Pty streams
// from arbitrary goroutines. The mutex covers both the AEAD encrypt
// (single-threaded AEAD use is the only safe pattern) and the underlying
// Send so the on-the-wire byte order matches the Send call order.

type SecureSyncClient struct {
	FileService_SyncClient
	aead        cipher.AEAD
	workspaceID string
	sendMu      sync.Mutex
}

type SecureSyncServer struct {
	FileService_SyncServer
	aead        cipher.AEAD
	workspaceID string
	sendMu      sync.Mutex
}

type SecureExecClient struct {
	FileService_ExecClient
	aead        cipher.AEAD
	workspaceID string
	sendMu      sync.Mutex
}

type SecureExecServer struct {
	FileService_ExecServer
	aead        cipher.AEAD
	workspaceID string
	sendMu      sync.Mutex
}

type SecurePtyClient struct {
	FileService_PtyClient
	aead        cipher.AEAD
	workspaceID string
	sendMu      sync.Mutex
}

type SecurePtyServer struct {
	FileService_PtyServer
	aead        cipher.AEAD
	workspaceID string
	sendMu      sync.Mutex
}

func (s *SecureSyncClient) WorkspaceID() string { return s.workspaceID }

// NewSecureSyncClient wraps a raw stream with AES-256-GCM. workspaceID is
// echoed in plaintext on every outgoing envelope so the server can route
// without first decrypting (it doesn't yet know which key to try).
func NewSecureSyncClient(stream FileService_SyncClient, key []byte, workspaceID string) (*SecureSyncClient, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	return &SecureSyncClient{FileService_SyncClient: stream, aead: aead, workspaceID: workspaceID}, nil
}

func NewSecureExecClient(stream FileService_ExecClient, key []byte, workspaceID string) (*SecureExecClient, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	return &SecureExecClient{FileService_ExecClient: stream, aead: aead, workspaceID: workspaceID}, nil
}

func NewSecurePtyClient(stream FileService_PtyClient, key []byte, workspaceID string) (*SecurePtyClient, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	return &SecurePtyClient{FileService_PtyClient: stream, aead: aead, workspaceID: workspaceID}, nil
}

// AcceptSyncStream is the server-side equivalent of NewSecureSyncClient: it
// pulls the first envelope off the raw stream, looks up the workspace's key
// via the resolver, decrypts the inner hello, and returns a wrapped stream
// the handler can use for the rest of the session. The decrypted hello is
// returned as well so the caller can validate Type/WorkspaceID without
// reading the next message.
//
// All failure paths return the same wire error (ReasonHandshakeRejected) so
// outsiders can't distinguish "unknown workspace" from "decrypt failed" via
// probing; the detailed cause is returned to the caller for server-side
// logging only.
func AcceptSyncStream(
	ctx context.Context,
	stream FileService_SyncServer,
	resolver KeyResolver,
) (*SecureSyncServer, *Message, error) {
	envelope, err := stream.Recv()
	if err != nil {
		return nil, nil, err
	}
	if envelope.WorkspaceID == "" {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, errors.New("missing workspace_id in hello")
	}
	key, err := resolver.Resolve(ctx, envelope.WorkspaceID)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	inner, err := decryptEnvelope(aead, envelope)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	return &SecureSyncServer{
		FileService_SyncServer: stream,
		aead:                   aead,
		workspaceID:            envelope.WorkspaceID,
	}, inner, nil
}

// AcceptExecStream mirrors AcceptSyncStream for the Exec RPC.
func AcceptExecStream(
	ctx context.Context,
	stream FileService_ExecServer,
	resolver KeyResolver,
) (*SecureExecServer, *Message, error) {
	envelope, err := stream.Recv()
	if err != nil {
		return nil, nil, err
	}
	if envelope.WorkspaceID == "" {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, errors.New("missing workspace_id in command")
	}
	key, err := resolver.Resolve(ctx, envelope.WorkspaceID)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	inner, err := decryptEnvelope(aead, envelope)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	return &SecureExecServer{
		FileService_ExecServer: stream,
		aead:                   aead,
		workspaceID:            envelope.WorkspaceID,
	}, inner, nil
}

// AcceptPtyStream mirrors AcceptSyncStream for the Pty RPC.
func AcceptPtyStream(
	ctx context.Context,
	stream FileService_PtyServer,
	resolver KeyResolver,
) (*SecurePtyServer, *Message, error) {
	envelope, err := stream.Recv()
	if err != nil {
		return nil, nil, err
	}
	if envelope.WorkspaceID == "" {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, errors.New("missing workspace_id in pty_start")
	}
	key, err := resolver.Resolve(ctx, envelope.WorkspaceID)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	inner, err := decryptEnvelope(aead, envelope)
	if err != nil {
		_ = stream.Send(rejectEnvelope())
		return nil, nil, err
	}
	return &SecurePtyServer{
		FileService_PtyServer: stream,
		aead:                  aead,
		workspaceID:           envelope.WorkspaceID,
	}, inner, nil
}

// WorkspaceID exposes the negotiated workspace id for handlers to know which
// directory under sync_root to operate on.
func (s *SecureSyncServer) WorkspaceID() string { return s.workspaceID }
func (s *SecureExecServer) WorkspaceID() string { return s.workspaceID }
func (s *SecurePtyServer) WorkspaceID() string  { return s.workspaceID }

// rejectEnvelope wraps the canonical handshake-rejection message. It is
// sent on a stream that hasn't completed handshake yet (no encryption), so
// we must not leak which specific check failed — the client side reads
// Type=error envelopes with an empty Data field and surfaces a generic
// "handshake rejected" to the user via TransSyncStatus. Server logs retain
// the detailed reason returned from Accept*Stream.
func rejectEnvelope() *Message {
	return &Message{
		Type:       MessageError,
		Error:      ReasonHandshakeRejected,
		ServerInfo: ReasonHandshakeRejected,
	}
}

func (s *SecureSyncClient) Send(msg *Message) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	secure, err := encryptMessage(s.aead, msg)
	if err != nil {
		return err
	}
	return s.FileService_SyncClient.Send(&Message{
		WorkspaceID: s.workspaceID,
		Data:        mustMarshal(secure),
	})
}

func (s *SecureSyncClient) Recv() (*Message, error) {
	msg, err := s.FileService_SyncClient.Recv()
	if err != nil {
		return nil, err
	}
	// Plaintext server-side rejection (workspace unknown, key revoked, etc).
	if msg.Type == MessageError && len(msg.Data) == 0 {
		return msg, nil
	}
	inner, err := decryptEnvelope(s.aead, msg)
	if err != nil {
		return nil, err
	}
	if ctrl := controlErrorFor(inner); ctrl != nil {
		return inner, ctrl
	}
	return inner, nil
}

func (s *SecureSyncServer) Send(msg *Message) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	secure, err := encryptMessage(s.aead, msg)
	if err != nil {
		return err
	}
	return s.FileService_SyncServer.Send(&Message{
		WorkspaceID: s.workspaceID,
		Data:        mustMarshal(secure),
	})
}

func (s *SecureSyncServer) Recv() (*Message, error) {
	msg, err := s.FileService_SyncServer.Recv()
	if err != nil {
		return nil, err
	}
	return decryptEnvelope(s.aead, msg)
}

func (s *SecureExecClient) Send(msg *Message) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	secure, err := encryptMessage(s.aead, msg)
	if err != nil {
		return err
	}
	return s.FileService_ExecClient.Send(&Message{
		WorkspaceID: s.workspaceID,
		Data:        mustMarshal(secure),
	})
}

func (s *SecureExecClient) Recv() (*Message, error) {
	msg, err := s.FileService_ExecClient.Recv()
	if err != nil {
		return nil, err
	}
	if msg.Type == MessageError && len(msg.Data) == 0 {
		return msg, nil
	}
	inner, err := decryptEnvelope(s.aead, msg)
	if err != nil {
		return nil, err
	}
	if ctrl := controlErrorFor(inner); ctrl != nil {
		return inner, ctrl
	}
	return inner, nil
}

func (s *SecureExecServer) Send(msg *Message) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	secure, err := encryptMessage(s.aead, msg)
	if err != nil {
		return err
	}
	return s.FileService_ExecServer.Send(&Message{
		WorkspaceID: s.workspaceID,
		Data:        mustMarshal(secure),
	})
}

func (s *SecureExecServer) Recv() (*Message, error) {
	msg, err := s.FileService_ExecServer.Recv()
	if err != nil {
		return nil, err
	}
	return decryptEnvelope(s.aead, msg)
}

func (s *SecurePtyClient) Send(msg *Message) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	secure, err := encryptMessage(s.aead, msg)
	if err != nil {
		return err
	}
	return s.FileService_PtyClient.Send(&Message{
		WorkspaceID: s.workspaceID,
		Data:        mustMarshal(secure),
	})
}

func (s *SecurePtyClient) Recv() (*Message, error) {
	msg, err := s.FileService_PtyClient.Recv()
	if err != nil {
		return nil, err
	}
	if msg.Type == MessageError && len(msg.Data) == 0 {
		return msg, nil
	}
	inner, err := decryptEnvelope(s.aead, msg)
	if err != nil {
		return nil, err
	}
	if ctrl := controlErrorFor(inner); ctrl != nil {
		return inner, ctrl
	}
	return inner, nil
}

// controlErrorFor inspects a freshly decrypted in-band MessageError and,
// for the wire reasons that the transport layer surfaces as typed Go
// errors today, returns the matching error so Recv() callers can use
// errors.Is(...) instead of inspecting m.Error strings. Returns nil
// for everything else (including non-MessageError types, plaintext
// rejections, and reasons that the layer above must dispatch itself,
// e.g. ReasonUpgradeRequired, ReasonFolderID*, ReasonSyncthingControlBlocked,
// ReasonStaleMembershipGeneration — those will be handled by the
// hello / lease modules when they land).
//
// Currently surfaced as typed errors:
//   - ReasonSessionReplaced -> ErrSessionReplaced (permanent kick)
//   - ReasonRevoked         -> ErrRevoked         (permanent revoke)
//
// Both kick the reconnect loop; the message body is still returned so
// the caller can read membership_generation / payload bits added later.
func controlErrorFor(m *Message) error {
	if m == nil || m.Type != MessageError {
		return nil
	}
	switch m.Error {
	case ReasonSessionReplaced:
		return ErrSessionReplaced
	case ReasonRevoked:
		return ErrRevoked
	default:
		return nil
	}
}

func (s *SecurePtyServer) Send(msg *Message) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	secure, err := encryptMessage(s.aead, msg)
	if err != nil {
		return err
	}
	return s.FileService_PtyServer.Send(&Message{
		WorkspaceID: s.workspaceID,
		Data:        mustMarshal(secure),
	})
}

func (s *SecurePtyServer) Recv() (*Message, error) {
	msg, err := s.FileService_PtyServer.Recv()
	if err != nil {
		return nil, err
	}
	return decryptEnvelope(s.aead, msg)
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errors.New("encryption key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func encryptMessage(aead cipher.AEAD, msg *Message) (*SecureMessage, error) {
	plain, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return &SecureMessage{
		Nonce:      nonce,
		Ciphertext: aead.Seal(nil, nonce, plain, nil),
	}, nil
}

func decryptEnvelope(aead cipher.AEAD, envelope *Message) (*Message, error) {
	if len(envelope.Data) == 0 {
		return nil, errors.New("missing encrypted message envelope")
	}
	var secure SecureMessage
	if err := json.Unmarshal(envelope.Data, &secure); err != nil {
		return nil, err
	}
	if len(secure.Nonce) != aead.NonceSize() {
		return nil, errors.New("invalid encrypted message nonce")
	}
	plain, err := aead.Open(nil, secure.Nonce, secure.Ciphertext, nil)
	if err != nil {
		return nil, err
	}
	var msg Message
	if err := json.Unmarshal(plain, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

func mustMarshal(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}
