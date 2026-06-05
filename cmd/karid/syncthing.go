package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/syncthing"
)

// startSyncthing brings up the embedded Syncthing sidecar (the OSS server's
// mandatory file-sync backend) and starts the reconcile loop. Syncthing is
// REQUIRED: any failure (binary missing, sidecar start, etc.) returns an
// error and the caller aborts startup — there is no silent degrade.
//
// Single-tenant: there is no registry-backed workspace catalog, so folders
// are adopted from Syncthing's own persisted config on startup and added on
// demand by the pair route as clients join.
func (s *server) startSyncthing(ctx context.Context) error {
	binary, err := findSyncthing(s.cfg.SyncthingBinary)
	if err != nil {
		return fmt.Errorf("syncthing binary not found (install syncthing or set --syncthing-binary): %w", err)
	}
	homeDir := filepath.Join(s.cfg.SyncDir, ".syncthing-home")
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return fmt.Errorf("syncthing home dir: %w", err)
	}
	// Owner-only home, and refuse a symlinked home (it could redirect
	// syncthing state outside the sync dir).
	if fi, err := os.Lstat(homeDir); err != nil {
		return fmt.Errorf("syncthing home dir stat: %w", err)
	} else if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("syncthing home dir %q is a symlink; refusing", homeDir)
	}
	if err := os.Chmod(homeDir, 0o700); err != nil {
		return fmt.Errorf("syncthing home dir chmod 0700: %w", err)
	}

	sidecar := syncthing.NewSidecarManager()
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := sidecar.Start(startCtx, syncthing.StartOptions{HomeDir: homeDir, Binary: binary}); err != nil {
		return fmt.Errorf("syncthing sidecar start: %w", err)
	}

	stopSidecar := func(reason string) {
		if stopErr := sidecar.Stop(context.WithoutCancel(ctx)); stopErr != nil {
			log.Printf("syncthing: stop after %s also failed: %v", reason, stopErr)
		}
	}

	sys, err := sidecar.Client().SystemStatus(startCtx)
	if err != nil || sys == nil || strings.TrimSpace(sys.MyID) == "" {
		stopSidecar("system-status failure")
		return fmt.Errorf("syncthing system status (empty myID): %w", err)
	}
	serverDevice := strings.TrimSpace(sys.MyID)

	// Keep the sidecar private: no LAN/global discovery, no relays/NAT.
	if err := sidecar.Client().PutOptions(startCtx, syncthing.ConfigOptions{
		LocalAnnounceEnabled:  false,
		GlobalAnnounceEnabled: false,
		RelaysEnabled:         false,
		NATEnabled:            false,
	}); err != nil {
		stopSidecar("put-options failure")
		return fmt.Errorf("syncthing put options: %w", err)
	}

	reconciler := syncthing.NewReconciler(sidecar.Client())
	// Adopt the persisted folder set BEFORE starting the reconcile loop —
	// running with an empty desired set would let the reconciler quarantine
	// healthy persisted folders as "unknown".
	n, err := adoptExistingKariSyncthingFolders(startCtx, sidecar.Client(), s.cfg.SyncDir, reconciler)
	if err != nil {
		stopSidecar("adopt failure")
		return fmt.Errorf("syncthing adopt existing folders: %w", err)
	}
	if n > 0 {
		log.Printf("syncthing: adopted %d existing folder(s) from persisted config", n)
	}
	go reconciler.Run(ctx, 10*time.Second)

	s.syncMu.Lock()
	s.syncSidecar = sidecar
	s.syncReconciler = reconciler
	s.syncDevice = serverDevice
	s.syncMu.Unlock()
	log.Printf("syncthing: up, server device=%s", serverDevice)
	return nil
}

// findSyncthing resolves the syncthing executable: an explicit absolute path
// from config, else the first `syncthing` on PATH.
func findSyncthing(explicit string) (string, error) {
	if t := strings.TrimSpace(explicit); t != "" {
		if !filepath.IsAbs(t) {
			return "", fmt.Errorf("syncthing_binary %q must be absolute", t)
		}
		info, err := os.Stat(t)
		if err != nil {
			return "", fmt.Errorf("syncthing_binary %q: %w", t, err)
		}
		if info.IsDir() {
			return "", fmt.Errorf("syncthing_binary %q is a directory", t)
		}
		return t, nil
	}
	return exec.LookPath("syncthing")
}

// adoptExistingKariSyncthingFolders reloads the desired folder set from
// Syncthing's own persisted config (registry-free single-tenant path).
func adoptExistingKariSyncthingFolders(ctx context.Context, client syncthing.Client, syncRoot string, reconciler *syncthing.Reconciler) (int, error) {
	if client == nil || reconciler == nil {
		return 0, fmt.Errorf("client/reconciler nil")
	}
	cfg, err := client.GetConfig(ctx)
	if err != nil {
		return 0, err
	}
	desired := desiredFromExistingKariSyncthingFolders(syncRoot, cfg)
	if err := reconciler.SetDesired(desired); err != nil {
		return 0, err
	}
	return len(desired.Folders), nil
}

func desiredFromExistingKariSyncthingFolders(syncRoot string, cfg *syncthing.Config) syncthing.Desired {
	var desired syncthing.Desired
	if cfg == nil {
		return desired
	}
	for _, f := range cfg.Folders {
		if !strings.HasPrefix(f.ID, "kari1_") {
			continue
		}
		if !pathInsideSyncRoot(syncRoot, f.Path) {
			continue
		}
		if hasSelfNestedChildPath(f.Path) {
			continue
		}
		desired.Folders = append(desired.Folders, syncthing.DesiredFolder{
			ID:      f.ID,
			Path:    f.Path,
			Type:    f.Type,
			Label:   f.Label,
			Paused:  f.Paused,
			Devices: append([]syncthing.Device(nil), f.Devices...),
		})
	}
	sort.Slice(desired.Folders, func(i, j int) bool {
		return desired.Folders[i].ID < desired.Folders[j].ID
	})
	return desired
}

func hasSelfNestedChildPath(folderPath string) bool {
	cleaned := filepath.Clean(folderPath)
	base := filepath.Base(cleaned)
	if base == "." || base == string(filepath.Separator) || strings.TrimSpace(base) == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(cleaned, base, base))
	return err == nil && info.IsDir()
}

func pathInsideSyncRoot(syncRoot, folderPath string) bool {
	if strings.TrimSpace(syncRoot) == "" || strings.TrimSpace(folderPath) == "" {
		return false
	}
	// Resolve symlinks so a folder that links outside the sync root can't be
	// adopted as "inside".
	root := resolvePath(syncRoot)
	child := resolvePath(folderPath)
	rel, err := filepath.Rel(root, child)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func resolvePath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = filepath.Clean(p)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return abs
}
