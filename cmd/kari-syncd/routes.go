package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"os"

	"github.com/binsonzhang95-maker/kari/internal/execpolicy"
	"github.com/binsonzhang95-maker/kari/internal/gitutil"
	"github.com/binsonzhang95-maker/kari/internal/syncd"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

func newMux(svc *syncd.Service, shutdownFns ...func()) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"version":  version,
			"shutdown": true,
			"time":     time.Now().UTC(),
		})
	})

	mux.HandleFunc("/v1/bind", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req syncd.BindRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if err := svc.Bind(req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

	mux.HandleFunc("/v1/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := svc.Start(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

	mux.HandleFunc("/v1/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		svc.Stop()
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

	mux.HandleFunc("/v1/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		svc.Stop()
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		if len(shutdownFns) > 0 && shutdownFns[0] != nil {
			shutdownFns[0]()
		}
	})

	mux.HandleFunc("/v1/sync-once", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Backwards-compatible shim: internally creates a sync-task
		// with initiator="manual" so old Desktop builds (which still
		// poll /v1/sync-once) keep working. Returns the legacy ok-only
		// shape; the new sync-task lifecycle is observable via the
		// /v1/sync-tasks family for callers that need barrier-precise
		// completion.
		if _, _, err := svc.CreateSyncTask(syncd.TaskDirectionBoth, "manual"); err != nil {
			// L2 sub-commit B: syncthing workspace bound without
			// staging_id is a deliberate gate, NOT a "daemon not
			// bound" error — must not fall back to TriggerSync (which
			// the gate also no-ops, but emitting a structured 409 to
			// the caller is the contract Desktop's L1 expects, and
			// avoids the legacy "ok:true" lie). Match handleCreateSyncTask
			// shape so callers see one consistent code.
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
			// Fall back to the original fire-and-forget path so a
			// pre-bound daemon (no workspace) still services /sync-once
			// the way old Desktop builds expect.
			if err := svc.TriggerSync(); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

	registerSyncTaskRoutes(mux, svc)
	registerSyncVerifyRoute(mux, svc)
	registerAutoSnapshotRoutes(mux, svc)

	mux.HandleFunc("/v1/force-upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Paths []string `json:"paths"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		count, err := svc.ForceUpload(r.Context(), body.Paths)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "entries": count})
	})

	mux.HandleFunc("/v1/pty-attach", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			LocalPath string `json:"local_path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		res, err := svc.PtyAttach(r.Context(), body.LocalPath)
		if err != nil {
			http.Error(w, err.Error(), httpStatusForAttach(err))
			return
		}
		_ = json.NewEncoder(w).Encode(res)
	})

	mux.HandleFunc("/v1/clipboard-image", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// 5 s ceiling so a wedged PowerShell on Windows can't hang the
		// extension's Cmd+V indefinitely — at that point we'd rather
		// the user fall through to a plain text paste than wait.
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		localPath, err := syncd.ReadClipboardImage(ctx)
		if errors.Is(err, syncd.ErrClipboardNoImage) {
			_ = json.NewEncoder(w).Encode(map[string]any{"has_image": false})
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"has_image":  true,
			"local_path": localPath,
		})
	})

	mux.HandleFunc("/v1/status", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(svc.Status())
	})

	mux.HandleFunc("/v1/ssh-status", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(syncd.ProbeSSHStatus())
	})

	mux.HandleFunc("/v1/bootstrap", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			GitURL   string `json:"git_url"`
			Username string `json:"username"`
			Password string `json:"password"`
			Flatten  bool   `json:"flatten"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		gitURL := strings.TrimSpace(body.GitURL)
		if gitURL == "" {
			http.Error(w, "git_url required", http.StatusBadRequest)
			return
		}
		// Embed credentials directly into the URL before handing it to
		// transport. The workbench sends them as separate fields purely
		// for UI hygiene (type=password); over the wire they ride in
		// the URL inside an already AES-encrypted envelope, which the
		// server logs scrub before persisting anything.
		if body.Username != "" || body.Password != "" {
			parsed, perr := url.Parse(gitURL)
			if perr == nil {
				if body.Password != "" {
					parsed.User = url.UserPassword(body.Username, body.Password)
				} else {
					parsed.User = url.User(body.Username)
				}
				gitURL = parsed.String()
			}
		}
		if err := svc.RequestBootstrap(transport.BootstrapRequest{GitURL: gitURL, Flatten: body.Flatten}); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "queued"})
	})

	mux.HandleFunc("/v1/bootstrap-status", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(svc.Status().LastBootstrap)
	})

	// /v1/remote-sessions backs the VS Code extension's history
	// TreeView. Optional ?sources= filter is a comma-separated subset
	// of {"claude","claude-one","codex"}; empty means all three.
	// Returns the daemon's cached list (30s TTL) when fresh, otherwise
	// proxies through the encrypted sync stream to the server's scanner.
	mux.HandleFunc("/v1/remote-sessions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		started := time.Now()
		var req transport.ListSessionsRequest
		if raw := strings.TrimSpace(r.URL.Query().Get("sources")); raw != "" {
			for _, s := range strings.Split(raw, ",") {
				if s = strings.TrimSpace(s); s != "" {
					req.Sources = append(req.Sources, s)
				}
			}
		}
		req.ForceRefresh = truthyQuery(r.URL.Query().Get("refresh")) || truthyQuery(r.URL.Query().Get("force"))
		result, err := svc.ListRemoteSessions(r.Context(), req)
		if err != nil {
			// Log the failure path so we can tell from daemon.log
			// whether the extension is asking and being told no, vs
			// not asking at all.
			log.Printf("/v1/remote-sessions: %v (elapsed=%s)", err, time.Since(started))
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		total := 0
		for _, s := range result.Sources {
			total += len(s.Sessions)
		}
		log.Printf("/v1/remote-sessions: ok total=%d elapsed=%s", total, time.Since(started))
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(result)
	})

	// /v1/git-remote reports the best-known repository identity for the
	// bound workspace: live [remote "origin"] when a git checkout exists,
	// otherwise the bootstrap repo-lock URL when available.
	mux.HandleFunc("/v1/git-remote", func(w http.ResponseWriter, _ *http.Request) {
		st := svc.Status()
		root := st.WorkspaceRoot
		if root == "" {
			http.Error(w, "no workspace bound", http.StatusServiceUnavailable)
			return
		}
		remoteURL := gitRemoteURL(root)
		lockURL, lockExists := repoLockURL(root)
		repoURL := remoteURL
		if repoURL == "" && lockExists {
			repoURL = lockURL
		}
		if repoURL == "" {
			repoURL = st.PeerRepoURL
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"url":           repoURL,
			"remote_url":    remoteURL,
			"root":          root,
			"lock_url":      lockURL,
			"lock_exists":   lockExists,
			"peer_repo_url": st.PeerRepoURL,
			"repo_match":    repoURL != "" && st.PeerRepoURL != "" && repoURL == st.PeerRepoURL,
		})
	})

	mux.HandleFunc("/v1/transfer", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(svc.Transfers())
	})

	// /v1/incoming-changes/before backs the VS Code extension's
	// kari-before:// FileSystemProvider. Returns the bytes of the file
	// at ?path=<rel> as it existed locally just before the most recent
	// inbound sync overwrote/deleted it. 404 means "no snapshot" —
	// the QuickDiffProvider treats that as "nothing to diff against"
	// and gutter bars simply don't render for that file.
	mux.HandleFunc("/v1/incoming-changes/before", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		rel := r.URL.Query().Get("path")
		if rel == "" {
			http.Error(w, "path is required", http.StatusBadRequest)
			return
		}
		bytes, ok := svc.IncomingPreImage(rel)
		if !ok {
			http.Error(w, "no snapshot", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(bytes)
	})

	mux.HandleFunc("/v1/exec-policy", func(w http.ResponseWriter, r *http.Request) {
		path := execpolicy.DefaultPolicyPath()
		if path == "" {
			http.Error(w, "cannot resolve $KARI_HOME for policy file", http.StatusInternalServerError)
			return
		}
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(path)
			if err != nil {
				if os.IsNotExist(err) {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write(execpolicy.DefaultPolicyJSON())
					return
				}
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(data)
		case http.MethodPost:
			body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			// Validate by attempting a parse via a throwaway loader.
			tmpDir := os.TempDir()
			tmpPath := tmpDir + string(os.PathSeparator) + "kari-exec-policy-validate.json"
			if err := os.WriteFile(tmpPath, body, 0o600); err != nil {
				http.Error(w, "stage: "+err.Error(), http.StatusInternalServerError)
				return
			}
			defer os.Remove(tmpPath)
			loader := execpolicy.NewLoader(tmpPath)
			if _, err := loader.Load(); err != nil {
				http.Error(w, "invalid policy: "+err.Error(), http.StatusBadRequest)
				return
			}
			// Ensure the destination directory exists (first-run case).
			if err := os.MkdirAll(filepathDir(path), 0o700); err != nil {
				http.Error(w, "ensure dir: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if err := os.WriteFile(path, body, 0o600); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": path})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/v1/exec-history", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		auditPath := syncd.LocalExecAuditPath()
		if auditPath == "" {
			http.Error(w, "cannot resolve $KARI_HOME for audit log", http.StatusInternalServerError)
			return
		}
		limit := 50
		if q := r.URL.Query().Get("limit"); q != "" {
			// Soft cap to avoid pathological responses; clamp [1, 500].
			if n, err := parsePositiveInt(q); err == nil && n > 0 {
				if n > 500 {
					n = 500
				}
				limit = n
			}
		}
		entries, err := tailJSONL(auditPath, limit)
		if err != nil {
			if os.IsNotExist(err) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"entries":[]}`))
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": entries})
	})

	return mux
}

// tailJSONL reads up to limit lines from the END of a jsonl file and
// returns them parsed as generic maps so the renderer can show
// whatever fields the audit format currently writes (no shared schema
// dependency between daemon HTTP layer and the audit struct). Used by
// /v1/exec-history. Streams a window of the file from the end rather
// than the whole thing — audit logs grow to 50 MB before rotation.
func tailJSONL(path string, limit int) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := stat.Size()
	const window int64 = 1 << 20 // 1 MiB tail; plenty for 50 entries of typical audit lines
	start := size - window
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	lines := bytes.Split(body, []byte("\n"))
	// Drop the head fragment if we seeked past start (might be a partial line).
	if start > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	out := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal(line, &entry); err != nil {
			// Skip malformed lines (audit log was likely concurrently
			// rotating). Don't fail the whole listing on one bad row.
			continue
		}
		out = append(out, entry)
	}
	return out, nil
}

func parsePositiveInt(s string) (int, error) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a positive integer")
		}
		n = n*10 + int(c-'0')
		if n > 1_000_000 {
			return 0, errors.New("too large")
		}
	}
	if n == 0 {
		return 0, errors.New("zero")
	}
	return n, nil
}

func filepathDir(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == os.PathSeparator {
			if i == 0 {
				return string(os.PathSeparator)
			}
			return path[:i]
		}
	}
	return "."
}

func truthyQuery(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

// httpStatusForAttach maps PtyAttach sentinel errors to HTTP status
// codes the VS Code extension (or anything else hitting the daemon)
// can branch on without parsing message text.
func httpStatusForAttach(err error) int {
	switch {
	case errors.Is(err, syncd.ErrAttachNotBound), errors.Is(err, syncd.ErrAttachNoSession):
		return http.StatusServiceUnavailable
	case errors.Is(err, syncd.ErrAttachBadPath), errors.Is(err, syncd.ErrAttachNotImage), errors.Is(err, syncd.ErrAttachTooLarge):
		return http.StatusBadRequest
	case errors.Is(err, syncd.ErrAttachTimeout):
		return http.StatusGatewayTimeout
	default:
		return http.StatusInternalServerError
	}
}

// gitRemoteURL / repoLockURL are thin shims so existing call sites in
// this file don't have to learn the gitutil import. New code should
// call gitutil directly.
func gitRemoteURL(root string) string        { return gitutil.RemoteOriginURL(root) }
func repoLockURL(root string) (string, bool) { return gitutil.RepoLockURL(root) }
