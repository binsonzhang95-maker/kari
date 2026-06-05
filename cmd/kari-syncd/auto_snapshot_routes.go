package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/syncd"
)

// Auto-snapshot Phase 1 — Desktop-driven dirty tracking HTTP surface.
//
// Daemon is a pure state machine:
//   - POST /v1/auto-snapshot/notify  (Desktop saw a local change)
//   - POST /v1/auto-snapshot/ack     (Desktop fired/declined upload)
//   - GET  /v1/status                (returns auto_snapshot_due bool)
//
// Desktop's existing fs watcher (used for UI dot rendering on modified
// files) is the natural detection point; replicating it inside the
// daemon would duplicate work and risk drift against Desktop's
// gitignore handling. Daemon just keeps the dirty + debounce +
// min-interval state machine.
//
// Notify is 204 No Content on success — no payload needed since
// /v1/status carries all the observable state.
//
// Ack accepts an optional JSON body {"fired_for": "<RFC3339Nano>"}
// where fired_for is the auto_snapshot_last_change_at value Desktop
// observed in /v1/status when it decided to fire. Daemon uses this
// to detect notifies that arrived DURING the upload window and
// preserve the dirty signal for the next cycle. Empty body / missing
// field = legacy "unconditional clear" semantics (older Desktop
// builds).
type autoSnapshotAckRequest struct {
	FiredFor *time.Time `json:"fired_for,omitempty"`
}

func registerAutoSnapshotRoutes(mux *http.ServeMux, svc *syncd.Service) {
	mux.HandleFunc("/v1/auto-snapshot/notify", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		svc.NotifyAutoSnapshotChange()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/v1/auto-snapshot/ack", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req autoSnapshotAckRequest
		if r.ContentLength > 0 {
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
		}
		var firedFor time.Time
		if req.FiredFor != nil {
			firedFor = *req.FiredFor
		}
		svc.AckAutoSnapshot(firedFor)
		w.WriteHeader(http.StatusNoContent)
	})
}
