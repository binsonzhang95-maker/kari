package filesync

import (
	"sort"
	"time"
)

// TransferRow is one in-flight (or recently-finished) file transfer
// surfaced via daemon /v1/transfer. JSON-tagged for direct serialization.
//
// PR2 Phase 1 commit 4 additive fields: WorkspaceID, WorkspaceName,
// Phase, Error. The engine itself doesn't know the per-license
// workspace_id, so those two fields are injected by Service.Transfers
// just before serialization. Phase + Error are derived from
// Direction + transferAbort error capture respectively. Old callers
// that only consume Path/Direction/Bytes* keep working unchanged
// (additive shape only — round-1 review backward-compat lock).
//
// Phase semantics (locked per plan §3.3):
//   - Only "uploading" or "downloading" emitted by daemon.
//   - synced/failed/blocked are NEVER set here — Desktop main
//     cache derives those from sync-once results, daemon offline
//     polls, and transfer-row error field.
type TransferRow struct {
	Path       string    `json:"path"`
	Direction  string    `json:"direction"` // "up" | "down"
	BytesDone  int64     `json:"bytes_done"`
	BytesTotal int64     `json:"bytes_total"`
	Started    time.Time `json:"started"`
	Resumed    bool      `json:"resumed,omitempty"`
	Completed  bool      `json:"completed,omitempty"`
	// PR2 Phase 1 additive fields (commit 4). All are populated
	// at serialization time by Service.Transfers (workspace_*)
	// or directly by the engine (Phase from Direction, Error
	// from transferAbort).
	WorkspaceID   string `json:"workspace_id,omitempty"`
	WorkspaceName string `json:"workspace_name,omitempty"`
	Phase         string `json:"phase,omitempty"` // "uploading" | "downloading"
	Error         string `json:"error,omitempty"` // non-empty → Desktop derives `failed`
	completeAt    time.Time `json:"-"` // not serialized; controls 3s linger
	abortedAt     time.Time `json:"-"` // linger window for error rows
}

// transferBegin starts tracking one in-flight file. size may be zero
// if unknown (initial chunk before meta); BytesTotal updates as chunks
// arrive. resumed=true means we started past byte 0 — Workbench shows
// a "↻ resumed" badge.
func (e *Engine) transferBegin(rel, direction string, size int64, resumed bool) {
	key := direction + ":" + rel
	e.mu.Lock()
	defer e.mu.Unlock()
	e.transfers[key] = &TransferRow{
		Path:       rel,
		Direction:  direction,
		BytesTotal: size,
		Started:    time.Now(),
		Resumed:    resumed,
	}
}

// transferProgress advances BytesDone for an in-flight row. Safe to
// call with delta=0 (no-op) and with a key that doesn't exist (likely
// raced past Complete already — silent return).
func (e *Engine) transferProgress(rel, direction string, delta int64) {
	if delta <= 0 {
		return
	}
	key := direction + ":" + rel
	e.mu.Lock()
	defer e.mu.Unlock()
	if row, ok := e.transfers[key]; ok {
		row.BytesDone += delta
	}
}

// transferComplete marks a row as done and schedules its removal 3 s
// from now. The 3-second linger means the Workbench can show a green
// checkmark for at least one poll cycle before the row vanishes.
func (e *Engine) transferComplete(rel, direction string) {
	key := direction + ":" + rel
	e.mu.Lock()
	defer e.mu.Unlock()
	if row, ok := e.transfers[key]; ok {
		row.Completed = true
		row.BytesDone = row.BytesTotal
		row.completeAt = time.Now()
	}
}

// transferAbort marks a row as errored and schedules its removal 3s
// from now — same linger window as transferComplete. PR2 Phase 1
// commit 4: pre-fix this deleted the row outright, so Desktop never
// learned an upload had failed (it just saw the row vanish like a
// success). Carrying the error string + lingering lets Desktop's
// main cache derive `phase=failed` for the project card. Empty
// errMsg falls back to a generic placeholder so the field is
// always non-empty when Completed=false + lingering — that's the
// Desktop-side signal for "failed" vs "successfully completed".
func (e *Engine) transferAbort(rel, direction, errMsg string) {
	key := direction + ":" + rel
	if errMsg == "" {
		errMsg = "transfer aborted"
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if row, ok := e.transfers[key]; ok {
		row.Error = errMsg
		row.abortedAt = time.Now()
	}
}

// Transfers returns a snapshot of all in-flight + recently-completed
// + recently-aborted transfer rows for /v1/transfer. Sweeps rows
// past their 3s linger window on the way out so the map doesn't grow.
//
// PR2 Phase 1 commit 4: also derives Phase from Direction so each
// row carries "uploading" or "downloading" for Desktop consumption.
// Other phases (synced / failed / blocked) are Desktop's
// responsibility — never produced here.
func (e *Engine) Transfers() []TransferRow {
	now := time.Now()
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]TransferRow, 0, len(e.transfers))
	for key, row := range e.transfers {
		if row.Completed && now.Sub(row.completeAt) > 3*time.Second {
			delete(e.transfers, key)
			continue
		}
		if row.Error != "" && now.Sub(row.abortedAt) > 3*time.Second {
			delete(e.transfers, key)
			continue
		}
		snapshot := *row
		// Phase mirrors Direction: up → uploading, down → downloading.
		// We deliberately set this even for Completed=true rows during
		// the 3s linger — Desktop reads Completed/Error to decide
		// next-state synthesis, NOT Phase.
		switch snapshot.Direction {
		case "up":
			snapshot.Phase = "uploading"
		case "down":
			snapshot.Phase = "downloading"
		}
		out = append(out, snapshot)
	}
	// Stable order: completed first by start time, then in-flight by start time.
	sort.Slice(out, func(i, j int) bool {
		return out[i].Started.Before(out[j].Started)
	})
	return out
}
