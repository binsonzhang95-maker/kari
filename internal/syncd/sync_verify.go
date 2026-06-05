package syncd

// SyncVerify is the daemon-side backing for GET /v1/sync-verify (sync-verify
// sub-commit 2 — plan 2026-05-26). Desktop polls this endpoint AFTER the
// daemon-side SyncTask reaches succeeded and BEFORE Desktop commits the
// snapshot, as a standardized cross-backend "the transport really is
// quiesced" gate.
//
// CURRENT IMPLEMENTATION is a filesync-backed placeholder. The daemon
// does not yet have Syncthing integration (the trans-server side does,
// kari-syncd does not). We surface the same response shape Syncthing's
// /rest/db/status + /rest/db/completion would feed so that when daemon
// later gets a Syncthing client, the implementation swaps under the
// same API contract and Desktop keeps polling unchanged. Filesync mode
// returns "" for folder_id/peer_device_id and "unknown" for remote_state
// (we can't verify remote-side state without a Syncthing peer to ask).
//
// The succeeded gate is therefore a relaxation of the strict
// SyncTaskManager barrier: succeeded task + clean status snapshot +
// extra 3s quiet window. The 3s quiet adds safety above the manager's
// 1s quietWindow because verify runs after success, where Desktop is
// about to commit the snapshot — a false-positive ok=true at this stage
// is much costlier than at the manager-tick layer where false-positives
// only delay UI updates.
//
// Linearizability re-check (codex round-1 nit 3): the handler reads
// CurrentBindMetadata, then CurrentSyncTask, then re-reads
// CurrentBindMetadata. A racing Bind between the two reads — which is
// the staging_id_superseded case from the plan-review — flips the
// second-read staging_id, and we return reason="staging_id_superseded"
// rather than a stale task-state answer that no longer matches the
// caller's staging_id.

import (
	"time"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
)

// verifyMidHandlerHook fires inside SyncVerify between the two
// CurrentBindMetadata snapshots, after the task/status/transfers
// reads. Production is nil (no-op); tests assign it to simulate a
// concurrent Bind racing the handler. Without this hook, no unit
// test can reliably interleave a real Bind goroutine between the
// two reads to exercise the ABA epoch-mismatch path.
var verifyMidHandlerHook func()

// verifyQuietWindow is the additional "no activity for N" requirement
// layered on top of the SyncTaskManager succeeded barrier before
// /v1/sync-verify is willing to declare ok=true. 3s per plan §A2 to
// give the engine a wider settle margin than the manager's 1s
// quietWindow (false-positive at the verify gate is the costlier
// failure). var (not const) so tests can shrink.
var verifyQuietWindow = 3 * time.Second

// SyncVerifyResolution is how the handler maps a SyncVerify result
// to an HTTP status code. ONLY the structurally-invalid request path
// (BadRequest) leaks a 4xx; every other daemon decision rides on
// status=200 with ok/reason in the body.
//
// This split exists so Desktop's poll loop can use HTTP status as a
// stable "does this daemon have the endpoint at all?" signal: any 4xx
// MUST mean the daemon build is too old (router 404 / method 405) or
// the caller serialised an invalid query (400). It MUST NOT mean
// "endpoint exists but the daemon couldn't find the staging" — that
// path returns 200 + reason=no_match / no_task / daemon_not_bound, so
// Desktop can distinguish "skip verify, daemon predates rollout" from
// "verify ran and said no" without sniffing the response body.
type SyncVerifyResolution int

const (
	// SyncVerifyResolutionOK is "render the SyncVerifyResult as 200 JSON
	// — body.ok and body.reason carry the verdict." Covers every
	// daemon-side outcome except a structurally invalid query.
	SyncVerifyResolutionOK SyncVerifyResolution = iota
	// SyncVerifyResolutionBadRequest is "the caller's query is missing
	// both staging_id and workspace_name (or otherwise malformed)."
	// 400 on the wire.
	SyncVerifyResolutionBadRequest
)

// SyncVerifyResult mirrors the response shape /v1/sync-verify writes.
// Field order matches the plan's documented schema. JSON tags use
// snake_case to match every other daemon endpoint (and Desktop's
// existing fetch helpers). Several fields are degenerate in filesync
// mode (folder_id, peer_device_id = ""; remote_state = "unknown");
// they MUST still serialize so that Desktop's response parser doesn't
// have to branch on backend kind.
type SyncVerifyResult struct {
	OK         bool   `json:"ok"`
	StagingID  string `json:"staging_id,omitempty"`
	FolderID   string `json:"folder_id"`
	FolderPath string `json:"folder_path,omitempty"`
	Direction  string `json:"direction,omitempty"`
	// FolderMode mirrors Syncthing folder-type semantics so a future
	// Syncthing-backed implementation doesn't need a new field. Maps
	// TaskDirection upload/download/both → sendonly/receiveonly/sendreceive.
	FolderMode   string `json:"folder_mode,omitempty"`
	PeerDeviceID string `json:"peer_device_id"`
	// State: "idle" | "syncing" | "error". Derived from task state plus
	// transfer-row error presence. Distinct from ok — a task in
	// state="idle" can still be ok=false (e.g. quiet window not yet
	// satisfied; a Bind race produced staging_id_superseded).
	State       string `json:"state"`
	Completion  int    `json:"completion"`
	NeedBytes   int64  `json:"need_bytes"`
	NeedItems   int    `json:"need_items"`
	NeedDeletes int    `json:"need_deletes"`
	PullErrors  int    `json:"pull_errors"`
	// RemoteState: "valid" | "invalid" | "unknown". Filesync placeholder
	// always sets "unknown" — we cannot query a remote-side completion
	// store. Desktop treats "unknown" as "no remote-side signal; rely on
	// daemon-side fields." Syncthing implementation will fill the
	// valid/invalid arms later.
	RemoteState string `json:"remote_state"`
	QuietMS     int64  `json:"quiet_ms"`
	// Reason is a short machine-readable token explaining ok=false.
	// Empty when ok=true. Recognised values, grouped by Desktop's
	// expected response:
	//   TERMINAL (Desktop: bail, do not commit):
	//     - staging_id_superseded   query staging_id != current bind's
	//     - task_not_succeeded      task is still running/pending/failed/cancelled
	//     - pull_errors             one or more transfer rows have Error
	//     - daemon_not_bound        daemon has no current bind to verify against
	//     - no_match                staging_id / workspace_name doesn't match current bind
	//     - no_task                 bound, but no sync-task exists for this workspace
	//   RETRY (Desktop: keep polling within timeout):
	//     - pending_outbound        Status.PendingOutbound > 0
	//     - active_transfers        non-error in-flight transfer rows present
	//     - need_items_remaining    download task with items still to fetch
	//     - quiet_window_not_reached LastActivityAt too recent (< verifyQuietWindow)
	Reason string `json:"reason,omitempty"`
}

// syncVerifyNoMatchResult is the populated body emitted when the
// daemon-side resolver can't pair the caller's query against current
// state. Returned as 200 + ok=false so Desktop can distinguish from
// the 4xx "daemon doesn't have the route" path (old-daemon backward
// compat). The reason discriminates the three sub-cases.
func syncVerifyNoMatchResult(stagingIDQuery, reason string) SyncVerifyResult {
	return SyncVerifyResult{
		OK:           false,
		StagingID:    stagingIDQuery,
		FolderID:     "",
		PeerDeviceID: "",
		State:        "idle",
		RemoteState:  "unknown",
		Reason:       reason,
	}
}

// SyncVerify resolves a /v1/sync-verify query against the daemon's
// current bind + sync-task + status state. The handler is responsible
// for HTTP shape: it picks the status code from the SyncVerifyResolution
// and writes the result as JSON on the OK path.
//
// At least one of stagingIDQuery / workspaceNameQuery must be non-empty;
// stagingIDQuery wins when both are provided. Empty strings (omitted
// query params after TrimSpace) are treated as not-provided per
// codex round-1 nit 5 — never as a phantom match against an empty
// current bind.
func (s *Service) SyncVerify(stagingIDQuery, workspaceNameQuery string) (SyncVerifyResult, SyncVerifyResolution) {
	if stagingIDQuery == "" && workspaceNameQuery == "" {
		return SyncVerifyResult{}, SyncVerifyResolutionBadRequest
	}

	// Snapshot #1 — bind metadata at handler entry.
	curStg1, _, _, curWsName1, epoch1 := s.CurrentBindMetadata()
	if curWsName1 == "" {
		// Daemon not bound to anything; nothing to verify. 200 + reason
		// so Desktop can distinguish from "daemon has no /v1/sync-verify
		// route at all" (which surfaces as 404 from the http mux).
		return syncVerifyNoMatchResult(stagingIDQuery, "daemon_not_bound"), SyncVerifyResolutionOK
	}

	// Decide the workspace_name we look the task up under, and detect
	// staging_id_superseded as an explicit 200+ok=false rather than 404.
	wsName, resolveResult, resolveOK := s.resolveVerifyTarget(stagingIDQuery, workspaceNameQuery, curStg1, curWsName1)
	if !resolveOK {
		return syncVerifyNoMatchResult(stagingIDQuery, "no_match"), SyncVerifyResolutionOK
	}
	if resolveResult != nil {
		return *resolveResult, SyncVerifyResolutionOK
	}

	// Pull task + live status + transfer rows. Each of these acquires
	// s.mu separately; tickSyncTasks inside CurrentSyncTask refreshes
	// task state from the same status fields, so the three reads see
	// a consistent-enough snapshot when no Bind races in between.
	task, hasTask := s.CurrentSyncTask(wsName)
	status := s.Status()
	transfers := s.Transfers()

	if verifyMidHandlerHook != nil {
		verifyMidHandlerHook()
	}

	// Snapshot #2 — re-read bind metadata. Catches BOTH:
	//   - direct A→B mid-handler rebind (staging_id or workspace_name diverges)
	//   - A→B→A ABA where final values coincide with snapshot #1 but a
	//     Bind interleaved during the three reads above. The bindEpoch
	//     counter monotonically bumps on every successful Bind, so
	//     epoch1 != epoch2 → at least one Bind raced and the task/status
	//     reads may reflect a different workspace's state than the
	//     caller asked about. Either way: superseded (codex sub-commit-2
	//     review must-fix).
	curStg2, _, _, curWsName2, epoch2 := s.CurrentBindMetadata()
	if epoch1 != epoch2 || curStg1 != curStg2 || curWsName1 != curWsName2 {
		return SyncVerifyResult{
			StagingID:    stagingIDQuery,
			FolderID:     "",
			PeerDeviceID: "",
			State:        "idle",
			RemoteState:  "unknown",
			Reason:       "staging_id_superseded",
		}, SyncVerifyResolutionOK
	}

	if !hasTask {
		// Bound + matched, but no sync-task ever existed for this
		// workspace_name. 200 + reason so Desktop's poll loop can mark
		// terminal-bail without confusing this for a missing endpoint.
		return syncVerifyNoMatchResult(stagingIDQuery, "no_task"), SyncVerifyResolutionOK
	}

	return buildSyncVerifyResult(stagingIDQuery, task, status, transfers, time.Now()), SyncVerifyResolutionOK
}

// resolveVerifyTarget picks the workspace_name to look the task up
// under and emits the staging_id_superseded short-circuit when the
// caller's staging_id doesn't match the daemon's current one. Returns:
//   - wsName: workspace to query when the third return is nil
//   - result: populated SyncVerifyResult to return as-is (superseded case)
//   - ok: false → caller should emit a no_match-shaped 200 response;
//          true → proceed (either with wsName or with the supplied result)
func (s *Service) resolveVerifyTarget(stagingIDQuery, workspaceNameQuery, curStg, curWsName string) (string, *SyncVerifyResult, bool) {
	if stagingIDQuery != "" {
		if curStg == stagingIDQuery {
			return curWsName, nil, true
		}
		// Diverged. If the daemon has SOME staging_id but it doesn't
		// match the caller's, that's the supersedence case: a newer
		// Bind has overwritten the staging slot. Return 200+ok=false
		// so Desktop's polling loop can distinguish this from a 404
		// (which means "no bind / no task at all"). If the daemon has
		// no staging_id at all, we have no way to identify the
		// caller's intent against current state — 404 is correct.
		if curStg == "" {
			return "", nil, false
		}
		superseded := SyncVerifyResult{
			StagingID:    stagingIDQuery,
			FolderID:     "",
			PeerDeviceID: "",
			State:        "idle",
			RemoteState:  "unknown",
			Reason:       "staging_id_superseded",
		}
		return "", &superseded, true
	}
	// workspace_name fallback mode: must match the daemon's current
	// bound workspace exactly — otherwise we'd be inviting cross-
	// workspace data leakage on a poll for a stale workspace_name.
	if workspaceNameQuery != curWsName {
		return "", nil, false
	}
	return curWsName, nil, true
}

func buildSyncVerifyResult(stagingIDQuery string, task *SyncTask, status Status, transfers []filesync.TransferRow, now time.Time) SyncVerifyResult {
	pullErrors := 0
	needItems := 0
	var needBytes int64
	for _, r := range transfers {
		if r.Error != "" {
			pullErrors++
			continue
		}
		if r.Completed {
			continue
		}
		// "All bytes in but no Completed flag yet" — matches the
		// BarrierSnapshot suppress rule in sync_task_service.go so the
		// two layers agree on what "in flight" means.
		if r.BytesTotal > 0 && r.BytesDone >= r.BytesTotal {
			continue
		}
		needItems++
		if r.BytesTotal > r.BytesDone {
			needBytes += r.BytesTotal - r.BytesDone
		}
	}

	// Completion derives from the byte ratio so a task that the
	// manager declared "succeeded" via the empty-peer-download path
	// (BytesTotal=0) still reads as 100, while a manually-mutated or
	// otherwise byte-incomplete succeeded task can NOT phantom-pass
	// the verify gate. The plateau-settle path is the realistic source
	// of the latter — a succeeded download with bytes slightly under
	// BytesTotal should NOT report ok=true to Desktop's commit gate.
	completion := 100
	if task.BytesTotal > 0 {
		completion = int(task.BytesDone * 100 / task.BytesTotal)
		if completion > 100 {
			completion = 100
		}
	}

	var state string
	switch task.State {
	case TaskStateSucceeded, TaskStateCancelled:
		state = "idle"
	case TaskStateFailed:
		state = "error"
	default:
		state = "syncing"
	}

	var quietMS int64
	if !status.LastActivityAt.IsZero() {
		d := now.Sub(status.LastActivityAt).Milliseconds()
		if d > 0 {
			quietMS = d
		}
	}

	ok := false
	reason := ""
	switch {
	case task.State != TaskStateSucceeded:
		reason = "task_not_succeeded"
	case pullErrors > 0:
		reason = "pull_errors"
	case status.PendingOutbound != 0:
		reason = "pending_outbound"
	case needItems > 0:
		reason = "active_transfers"
	case task.Direction == TaskDirectionDownload && completion < 100:
		reason = "need_items_remaining"
	case quietMS < verifyQuietWindow.Milliseconds():
		reason = "quiet_window_not_reached"
	default:
		ok = true
	}

	if ok {
		// On the success path, normalise need_bytes/need_items to zero
		// — completion == 100 already implies nothing outstanding.
		needBytes = 0
	}

	return SyncVerifyResult{
		OK:           ok,
		StagingID:    stagingIDQuery,
		FolderID:     "",
		FolderPath:   status.WorkspaceRoot,
		Direction:    string(task.Direction),
		FolderMode:   verifyFolderMode(task.Direction),
		PeerDeviceID: "",
		State:        state,
		Completion:   completion,
		NeedBytes:    needBytes,
		NeedItems:    needItems,
		NeedDeletes:  0,
		PullErrors:   pullErrors,
		RemoteState:  "unknown",
		QuietMS:      quietMS,
		Reason:       reason,
	}
}

func verifyFolderMode(d TaskDirection) string {
	switch d {
	case TaskDirectionUpload:
		return "sendonly"
	case TaskDirectionDownload:
		return "receiveonly"
	default:
		return "sendreceive"
	}
}
