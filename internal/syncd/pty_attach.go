package syncd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// PtyAttach handles the "user dragged an image into the remote
// terminal" flow. The kari pty subprocess intercepts the bracketed
// paste, identifies a local image path, and POSTs it here. We copy
// the image into the workspace under .kari/uploads/, trigger a sync,
// and block until the server confirms the file landed before returning
// the wire-form (forward-slash) rel path the caller can stitch onto
// the remote work_dir.
//
// Sentinel errors are exported so the HTTP layer can map them to
// distinct status codes — callers shouldn't depend on the wording of
// the message, just the identity.
var (
	ErrAttachNotBound  = errors.New("daemon is not bound to a workspace")
	ErrAttachBadPath   = errors.New("bad local_path")
	ErrAttachNotImage  = errors.New("file is not a supported image type")
	ErrAttachTooLarge  = errors.New("file exceeds upload size limit")
	ErrAttachNoSession = errors.New("no active sync session — cannot ack upload")
	ErrAttachTimeout   = errors.New("timed out waiting for server to ack the upload")
)

const (
	// AttachMaxBytes caps drop-image uploads at 3 MB. The previous
	// 20 MB ceiling let a single phone photo wedge the encrypted sync
	// stream long enough that input started feeling sluggish; 3 MB
	// covers screenshots and crops (the common Cmd+V case) and forces
	// users to compress true photos before pasting, which is the right
	// trade for a real-time TUI workflow.
	AttachMaxBytes = 3 * 1024 * 1024
	// AttachWaitTimeout is how long PtyAttach will block on the
	// peer's synced ack. Most uploads land in well under a second;
	// 30 s is the "something's wrong" cutoff after which the daemon
	// reports failure to the kari pty client (which then transparently
	// forwards the original paste so the user can decide what to do).
	AttachWaitTimeout = 30 * time.Second
	// AttachUploadsDir is the wire-form (forward-slash) rel directory
	// where PtyAttach lands incoming images. Exempt from .gitignore by
	// the engine's shouldIgnore so users who ignore .kari/ wholesale
	// still get drop-image uploads.
	AttachUploadsDir = ".kari/uploads"
	// uploadsRetention is how long stale drops linger before the GC
	// loop deletes them. One week balances "user comes back Monday
	// and references last Friday's screenshot" against unbounded disk
	// growth on workspaces with chatty users.
	uploadsRetention = 7 * 24 * time.Hour
)

// attachImageExts lists the extensions PtyAttach accepts, intentionally
// matching Claude Code's image-paste regex (src/utils/imagePaste.ts:
// /\.(png|jpe?g|gif|webp)$/i). Adding extensions the CLI can't actually
// decode would just produce a successful upload that fails downstream.
var attachImageExts = map[string]struct{}{
	".png":  {},
	".jpg":  {},
	".jpeg": {},
	".gif":  {},
	".webp": {},
}

// PtyAttachResult is the response shape for /v1/pty-attach. RelPath is
// forward-slash form, suitable for joining onto the remote work_dir
// (which the kari pty client already learned from MessagePtyStart).
type PtyAttachResult struct {
	RemoteRelpath string `json:"remote_relpath"`
}

// PtyAttach validates the local file, copies it into the workspace,
// triggers a sync, and waits for the server's synced ack before
// returning the wire-form rel. The caller (HTTP handler) maps the
// returned error to an appropriate status code.
func (s *Service) PtyAttach(ctx context.Context, localPath string) (PtyAttachResult, error) {
	root := s.workspaceRootSnapshot()
	if root == "" {
		return PtyAttachResult{}, ErrAttachNotBound
	}

	clean := strings.TrimSpace(localPath)
	if clean == "" {
		return PtyAttachResult{}, fmt.Errorf("%w: empty", ErrAttachBadPath)
	}
	clean = filepath.Clean(clean)
	if !filepath.IsAbs(clean) {
		return PtyAttachResult{}, fmt.Errorf("%w: must be absolute", ErrAttachBadPath)
	}

	info, err := os.Lstat(clean)
	if err != nil {
		return PtyAttachResult{}, fmt.Errorf("%w: %v", ErrAttachBadPath, err)
	}
	if !info.Mode().IsRegular() {
		return PtyAttachResult{}, fmt.Errorf("%w: not a regular file", ErrAttachBadPath)
	}
	if info.Size() > AttachMaxBytes {
		return PtyAttachResult{}, fmt.Errorf("%w: %d bytes > %d limit", ErrAttachTooLarge, info.Size(), AttachMaxBytes)
	}
	ext := strings.ToLower(filepath.Ext(clean))
	if _, ok := attachImageExts[ext]; !ok {
		return PtyAttachResult{}, fmt.Errorf("%w: %s", ErrAttachNotImage, ext)
	}

	uploadName := uuid.NewString() + "-" + sanitizeBasename(filepath.Base(clean))
	dst := filepath.Join(root, ".kari", "uploads", uploadName)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return PtyAttachResult{}, fmt.Errorf("mkdir uploads: %w", err)
	}
	if err := copyFileAtomic(clean, dst); err != nil {
		return PtyAttachResult{}, fmt.Errorf("copy to workspace: %w", err)
	}

	rel := AttachUploadsDir + "/" + uploadName

	// Register the ack waiter *before* triggering sync so a fast peer
	// can't ack between our trigger and our select{}. WaitForUpAck
	// returns ok=false when no session is active — degrade to polling
	// transfers, which is less precise but unblocks the caller in the
	// "user dragged before daemon connected" edge case.
	ackCh, ackOK := s.WaitForUpAck(rel)
	if err := s.TriggerSync(); err != nil {
		return PtyAttachResult{}, fmt.Errorf("trigger sync: %w", err)
	}

	if ackOK {
		select {
		case <-ackCh:
			return PtyAttachResult{RemoteRelpath: rel}, nil
		case <-time.After(AttachWaitTimeout):
			return PtyAttachResult{}, ErrAttachTimeout
		case <-ctx.Done():
			return PtyAttachResult{}, ctx.Err()
		}
	}

	// No live session at trigger time. The previous "degraded" path
	// here polled for the file's presence in the local engine index —
	// but the file was JUST copied into .kari/uploads/ a few lines up,
	// so that check passed immediately and we returned a "success"
	// response carrying a remote path that the server actually never
	// received. The remote CLI then opened a missing file. Better to
	// fail fast so the kari sniffer surfaces `[kari] image upload
	// failed: …` and the user can retry once the session reconnects.
	return PtyAttachResult{}, ErrAttachNoSession
}

// workspaceRootSnapshot returns the currently-bound workspace root under
// the service lock so PtyAttach doesn't read a torn value mid-rebind.
func (s *Service) workspaceRootSnapshot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.TrimSpace(s.bind.WorkspaceRoot)
}

// sanitizeBasename strips path separators, control bytes, and characters
// reserved on Windows so the upload name is safe to land on a Windows
// server regardless of where the source file came from. Caps length so
// long original names can't blow past filesystem limits on stricter
// servers.
func sanitizeBasename(name string) string {
	const maxLen = 120
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20, r == 0x7f:
			b.WriteRune('_')
		case r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|':
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" {
		out = "file"
	}
	if len(out) > maxLen {
		// Preserve the trailing extension so the CLI's regex still
		// matches after truncation. Trim the stem, keep the ext.
		ext := filepath.Ext(out)
		if len(ext) > 0 && len(ext) < maxLen {
			out = out[:maxLen-len(ext)] + ext
		} else {
			out = out[:maxLen]
		}
	}
	return out
}

// copyFileAtomic writes src to dst+".part" then renames into place so
// the sync engine never sees a half-written upload (its watch would
// fire mid-copy otherwise and ship a corrupt file).
func copyFileAtomic(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// uploadsGCLoop sweeps stale drop-image uploads on a one-hour cadence.
// Runs alongside runLoop; exits when ctx is cancelled. The first sweep
// fires immediately so a daemon that's been off for weeks doesn't keep
// last month's files until the first tick.
func (s *Service) uploadsGCLoop(ctx context.Context) {
	s.gcUploadsOnce()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.gcUploadsOnce()
		}
	}
}

// gcUploadsOnce deletes files under .kari/uploads older than the
// retention window. Best-effort: errors are logged but don't crash the
// daemon — the worst case is we keep some stale files until the next
// pass, which is fine. The engine's watch will pick up the deletes and
// propagate them to the server on the next rescan.
func (s *Service) gcUploadsOnce() {
	root := s.workspaceRootSnapshot()
	if root == "" {
		return
	}
	dir := filepath.Join(root, ".kari", "uploads")
	cutoff := time.Now().Add(-uploadsRetention)
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// Most commonly: directory doesn't exist yet (no uploads).
			if errors.Is(err, fs.ErrNotExist) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if info.ModTime().Before(cutoff) {
			if rmErr := os.Remove(p); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
				log.Printf("uploads gc: remove %s: %v", p, rmErr)
			}
		}
		return nil
	})
}
