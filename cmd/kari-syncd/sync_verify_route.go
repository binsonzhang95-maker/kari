package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/binsonzhang95-maker/kari/internal/syncd"
)

// registerSyncVerifyRoute wires GET /v1/sync-verify. Thin parse+write
// shell over syncd.Service.SyncVerify so the verify decision logic
// stays in the syncd package where it's directly unit-testable.
//
// Query contract:
//   ?staging_id=<id>           preferred — matches the bind body's
//                              staging_id field that Desktop sends in
//                              B5 / B6c. SyncVerify returns
//                              ok=false + reason=staging_id_superseded
//                              when the daemon's current bind has a
//                              different staging_id (the
//                              plan-review option-2 decision).
//   ?workspace_name=<name>     fallback when staging_id is unknown;
//                              must match the daemon's current bound
//                              workspace.
//   neither                    400 — daemon refuses ambiguous queries
//                              instead of phantom-matching empty state.
//
// HTTP status mapping (driven by SyncVerifyResolution):
//   - SyncVerifyResolutionOK         → 200 + JSON body
//   - SyncVerifyResolutionBadRequest → 400 + plaintext error
//
// Daemon-side "no match" outcomes (daemon_not_bound / no_match / no_task)
// ride on 200 + ok=false + reason rather than 404 — that way the only
// 4xx surface is structurally-invalid-query (400) and "endpoint missing
// entirely" (mux 404 / method 405). Desktop's poll loop uses the
// 4xx-vs-200 split to distinguish "old daemon, skip verify path" from
// "daemon checked and said no, bail."
//
// Body shape pinning is enforced by the in-package
// internal/syncd/sync_verify_test.go suite; the route test in this
// package covers HTTP-layer concerns (method, query, status codes).
func registerSyncVerifyRoute(mux *http.ServeMux, svc *syncd.Service) {
	mux.HandleFunc("/v1/sync-verify", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		stagingID := strings.TrimSpace(q.Get("staging_id"))
		workspaceName := strings.TrimSpace(q.Get("workspace_name"))
		result, resolution := svc.SyncVerify(stagingID, workspaceName)
		if resolution == syncd.SyncVerifyResolutionBadRequest {
			http.Error(w, "staging_id or workspace_name required", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(result)
	})
}
