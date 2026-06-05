package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/binsonzhang95-maker/kari/internal/syncd"
)

// registerSyncTaskRoutes wires the /v1/sync-tasks family. Split out
// from routes.go so the new HTTP surface is easy to find and the
// shape pinning lives near its tests.
//
// Endpoints:
//   POST /v1/sync-tasks                          create or reuse an active task
//   GET  /v1/sync-tasks?active=true              list non-terminal tasks
//   GET  /v1/sync-tasks?workspace_id=...         filtered list (same family)
//   GET  /v1/sync-tasks/current?workspace_name=… most recent task (active or terminal)
//   GET  /v1/sync-tasks/{id}                     one task by ID
//   POST /v1/sync-tasks/{id}/cancel              cancel a pending/running task
//
// Wire shape: snake_case fields. Matches Desktop's normalizeSyncTask
// in src/main/main.cjs. nil tasks serialize as null; the Desktop
// abandonDownload path treats null as "no current task to cancel".
func registerSyncTaskRoutes(mux *http.ServeMux, svc *syncd.Service) {
	mux.HandleFunc("/v1/sync-tasks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			handleCreateSyncTask(w, r, svc)
		case http.MethodGet:
			handleListSyncTasks(w, r, svc)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Subpath mux: /v1/sync-tasks/{id}[/cancel] OR /v1/sync-tasks/current.
	mux.HandleFunc("/v1/sync-tasks/", func(w http.ResponseWriter, r *http.Request) {
		tail := strings.TrimPrefix(r.URL.Path, "/v1/sync-tasks/")
		if tail == "" {
			http.NotFound(w, r)
			return
		}
		if tail == "current" {
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleCurrentSyncTask(w, r, svc)
			return
		}
		// /{id}/cancel
		if strings.HasSuffix(tail, "/cancel") {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			id := strings.TrimSuffix(tail, "/cancel")
			handleCancelSyncTask(w, r, svc, id)
			return
		}
		// /{id}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleGetSyncTask(w, r, svc, tail)
	})
}

type createSyncTaskRequest struct {
	Direction   string `json:"direction"`
	Initiator   string `json:"initiator"`
	WorkspaceID string `json:"workspace_id,omitempty"` // optional; current Phase 1 always uses the bound workspace
}

func handleCreateSyncTask(w http.ResponseWriter, r *http.Request, svc *syncd.Service) {
	var req createSyncTaskRequest
	// Empty body is fine — defaults to direction=both / initiator=manual.
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
	}
	direction := syncd.TaskDirection(strings.TrimSpace(req.Direction))
	if direction == "" {
		direction = syncd.TaskDirectionBoth
	}
	task, _, err := svc.CreateSyncTask(direction, strings.TrimSpace(req.Initiator))
	if err != nil {
		// L2 sub-commit B: distinguish "syncthing workspace bound
		// without staging_id" (a deliberate gate, not a client error)
		// from generic create failures (no bind yet, bad direction).
		// 409 + JSON body matches the code Desktop's L1 postSyncTask
		// gate uses so the renderer can render a uniform "use Upload/
		// Download buttons" hint regardless of which layer caught it.
		var soe *syncd.SyncthingExplicitSyncOnlyError
		if errors.As(err, &soe) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error":     "syncthing_explicit_sync_only",
				"message":   soe.Error(),
				"direction": string(soe.Direction),
			})
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(task)
}

func handleListSyncTasks(w http.ResponseWriter, r *http.Request, svc *syncd.Service) {
	q := r.URL.Query()
	// active=true is the documented entry; treat any other value as
	// "list all" so curl experiments don't surprise.
	activeOnly := q.Get("active") == "true" || q.Get("active") == "1"
	wsID := strings.TrimSpace(q.Get("workspace_id"))
	tasks := svc.ActiveSyncTasks(wsID)
	w.Header().Set("Content-Type", "application/json")
	if !activeOnly {
		// We currently only surface active tasks via this endpoint;
		// terminal tasks are reachable via /current or /{id}. Returning
		// only the active set even when active!=true is intentional
		// (and documented) for v1 to keep the surface small.
		_ = json.NewEncoder(w).Encode(tasks)
		return
	}
	_ = json.NewEncoder(w).Encode(tasks)
}

func handleCurrentSyncTask(w http.ResponseWriter, r *http.Request, svc *syncd.Service) {
	wsName := strings.TrimSpace(r.URL.Query().Get("workspace_name"))
	if wsName == "" {
		http.Error(w, "workspace_name required", http.StatusBadRequest)
		return
	}
	task, ok := svc.CurrentSyncTask(wsName)
	w.Header().Set("Content-Type", "application/json")
	if !ok {
		// Desktop tolerates null here; means "no record".
		_, _ = w.Write([]byte("null"))
		return
	}
	_ = json.NewEncoder(w).Encode(task)
}

func handleGetSyncTask(w http.ResponseWriter, r *http.Request, svc *syncd.Service, id string) {
	task, ok := svc.GetSyncTask(id)
	if !ok {
		http.Error(w, "task not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(task)
}

type cancelSyncTaskRequest struct {
	Reason string `json:"reason,omitempty"`
}

type cancelSyncTaskResponse struct {
	OK    bool            `json:"ok"`
	State syncd.TaskState `json:"state"`
	Task  *syncd.SyncTask `json:"task,omitempty"`
}

func handleCancelSyncTask(w http.ResponseWriter, r *http.Request, svc *syncd.Service, id string) {
	var req cancelSyncTaskRequest
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "user_cancelled"
	}
	task, ok := svc.CancelSyncTask(id, reason)
	if !ok {
		http.Error(w, "task not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(cancelSyncTaskResponse{OK: true, State: task.State, Task: task})
}
