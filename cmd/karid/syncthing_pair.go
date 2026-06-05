package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/binsonzhang95-maker/kari/internal/syncthing"
)

type syncthingPairRequest struct {
	DesktopDeviceID  string   `json:"desktop_device_id"`
	DesktopAddresses []string `json:"desktop_addresses,omitempty"`
	DesktopName      string   `json:"desktop_name,omitempty"`
	WorkspaceID      string   `json:"workspace_id"`
	WorkspaceName    string   `json:"workspace_name"`
	// ProjectPath is accepted for wire-compat but no longer namespaces the
	// folder — the synced unit is the whole workspace tree (see handler).
	ProjectPath string `json:"project_path,omitempty"`
}

type syncthingPairResponse struct {
	ServerDeviceID  string   `json:"server_device_id"`
	ServerAddresses []string `json:"server_addresses"`
	FolderID        string   `json:"folder_id"`
	FolderPath      string   `json:"folder_path"`
	WorkspaceName   string   `json:"workspace_name"`
	ProjectPath     string   `json:"project_path"`
}

// handleSyncthingPair lets a client join a workspace's Syncthing folder:
// it registers the client's device, ensures the folder + .stfolder marker
// exist, adds the device to the folder membership, and returns the server's
// device id + addresses so the client can configure its own side.
//
// The synced folder is the workspace tree at <sync_dir>/<workspace_id>/<workspace_name>
// — IDENTICAL to the path engineFor() roots the gRPC/PTY/exec tree at, so the
// files Syncthing mirrors and the directory a remote terminal opens in are the
// same. Namespacing by workspace_id (not workspace_name) keeps distinct
// workspaces that happen to share a name from colliding on one folder.
func (s *server) handleSyncthingPair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		pairErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	if !s.authHTTP(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="kari"`)
		pairErr(w, http.StatusUnauthorized, "unauthorized", "token required")
		return
	}

	s.syncMu.Lock()
	rec, serverDevice, sidecar := s.syncReconciler, s.syncDevice, s.syncSidecar
	s.syncMu.Unlock()
	if rec == nil || serverDevice == "" || sidecar == nil {
		pairErr(w, http.StatusServiceUnavailable, "syncthing_unavailable", "syncthing backend not running yet")
		return
	}

	var req syncthingPairRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		pairErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	req.DesktopDeviceID = strings.TrimSpace(req.DesktopDeviceID)
	req.WorkspaceID = strings.TrimSpace(req.WorkspaceID)
	req.WorkspaceName = strings.TrimSpace(req.WorkspaceName)
	req.ProjectPath = strings.TrimSpace(req.ProjectPath)
	if !looksLikeSyncthingDeviceID(req.DesktopDeviceID) {
		pairErr(w, http.StatusBadRequest, "invalid_device_id", "desktop_device_id is not a valid Syncthing device id")
		return
	}
	if req.WorkspaceID == "" {
		pairErr(w, http.StatusBadRequest, "invalid_request", "workspace_id is required")
		return
	}
	if req.WorkspaceName == "" {
		pairErr(w, http.StatusBadRequest, "invalid_request", "workspace_name is required")
		return
	}

	// The synced folder is the workspace tree, namespaced by workspace_id and
	// keyed identically to engineFor() so PTY/exec and Syncthing share one
	// directory. safeName() keeps each id/name to a single safe path segment.
	folderID := syncthing.FolderIDForWorkspaceID(req.WorkspaceID)
	folderPath := filepath.Join(s.cfg.SyncDir, safeName(req.WorkspaceID), safeName(req.WorkspaceName))

	// Folder dir + .stfolder marker must exist before telling Syncthing about
	// the folder, or it fail-closes with "folder marker missing".
	if err := os.MkdirAll(folderPath, 0o755); err != nil {
		pairErr(w, http.StatusInternalServerError, "mkdir_failed", err.Error())
		return
	}
	// Re-check containment after creating the dir: EvalSymlinks now resolves
	// real paths, catching a symlinked component that escapes sync_dir.
	if !pathInsideSyncRoot(s.cfg.SyncDir, folderPath) {
		pairErr(w, http.StatusBadRequest, "invalid_path", "resolved folder path escapes sync dir")
		return
	}
	if err := os.MkdirAll(filepath.Join(folderPath, ".stfolder"), 0o755); err != nil {
		pairErr(w, http.StatusInternalServerError, "marker_mkdir_failed", err.Error())
		return
	}

	// Register the desktop device in the top-level device list FIRST — a
	// folder can only reference devices that already exist there.
	desktopName := strings.TrimSpace(req.DesktopName)
	if desktopName == "" {
		desktopName = "kari-client"
	}
	if err := sidecar.Client().PutDevice(r.Context(), req.DesktopDeviceID, desktopName, req.DesktopAddresses); err != nil {
		pairErr(w, http.StatusInternalServerError, "put_device_failed", err.Error())
		return
	}
	s.pairMu.Lock()
	err := addDesktopDeviceToFolder(rec, folderID, folderPath, serverDevice, req.WorkspaceName, req)
	s.pairMu.Unlock()
	if err != nil {
		pairErr(w, http.StatusInternalServerError, "reconciler_failed", err.Error())
		return
	}
	rec.RequestReconcile()

	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(syncthingPairResponse{
		ServerDeviceID:  serverDevice,
		ServerAddresses: s.syncthingServerAddresses(r),
		FolderID:        folderID,
		FolderPath:      folderPath,
		WorkspaceName:   req.WorkspaceName,
		ProjectPath:     req.ProjectPath,
	})
}

// syncthingServerAddresses advertises where the client should reach the
// server's Syncthing — the request host at the configured BEP port (default
// 22000). Override the whole address with --syncthing-addr.
func (s *server) syncthingServerAddresses(r *http.Request) []string {
	if a := strings.TrimSpace(s.cfg.SyncthingAddr); a != "" {
		return []string{a}
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if strings.TrimSpace(host) == "" {
		return nil
	}
	port := s.cfg.SyncthingPort
	if port <= 0 {
		port = 22000
	}
	return []string{"tcp://" + net.JoinHostPort(host, fmt.Sprintf("%d", port))}
}

// addDesktopDeviceToFolder creates or updates the folder's desired state so
// the server self + the desktop device share it (sendreceive, unpaused).
func addDesktopDeviceToFolder(rec *syncthing.Reconciler, folderID, folderPath, serverSelfDevice, workspaceName string, req syncthingPairRequest) error {
	// dedupeDevices builds the membership — server self + existing + this
	// desktop — with duplicate DeviceIDs (including desktop == server)
	// collapsed, since the reconciler rejects folders with duplicate ids.
	dedupeDevices := func(existing []syncthing.Device) []syncthing.Device {
		seen := make(map[string]bool, len(existing)+2)
		out := make([]syncthing.Device, 0, len(existing)+2)
		add := func(id string) {
			id = strings.TrimSpace(id)
			if id == "" || seen[id] {
				return
			}
			seen[id] = true
			out = append(out, syncthing.Device{DeviceID: id})
		}
		add(serverSelfDevice)
		for _, d := range existing {
			add(d.DeviceID)
		}
		add(req.DesktopDeviceID)
		return out
	}

	desired := rec.Desired()
	for i := range desired.Folders {
		if desired.Folders[i].ID == folderID {
			desired.Folders[i].Devices = dedupeDevices(desired.Folders[i].Devices)
			if folderPath != "" {
				desired.Folders[i].Path = folderPath
			}
			desired.Folders[i].Type = syncthing.FolderTypeSendReceive
			desired.Folders[i].Label = workspaceName
			desired.Folders[i].Paused = false
			if err := rec.SetDesired(desired); err != nil {
				return fmt.Errorf("set desired (update): %w", err)
			}
			return nil
		}
	}
	desired.Folders = append(desired.Folders, syncthing.DesiredFolder{
		ID:      folderID,
		Path:    folderPath,
		Type:    syncthing.FolderTypeSendReceive,
		Label:   workspaceName,
		Paused:  false,
		Devices: dedupeDevices(nil),
	})
	if err := rec.SetDesired(desired); err != nil {
		return fmt.Errorf("set desired (create): %w", err)
	}
	return nil
}

// looksLikeSyncthingDeviceID does the minimal shape check: 7 or 8
// dash-separated groups of 7 uppercase base32 chars.
func looksLikeSyncthingDeviceID(s string) bool {
	if s == "" {
		return false
	}
	parts := strings.Split(s, "-")
	if len(parts) != 7 && len(parts) != 8 {
		return false
	}
	for _, p := range parts {
		if len(p) != 7 {
			return false
		}
		for i := 0; i < len(p); i++ {
			c := p[i]
			if !((c >= 'A' && c <= 'Z') || (c >= '2' && c <= '7')) {
				return false
			}
		}
	}
	return true
}

func pairErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": msg})
}
