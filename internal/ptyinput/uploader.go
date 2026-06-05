package ptyinput

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"sync/atomic"
	"time"
)

// Uploader is what the Sniffer calls when it has identified a dropped
// image. Implementations turn the local path into the remote absolute
// path that should be emitted back into the PTY stream. The returned
// string is meant to be pasted verbatim (already correctly separator-
// formatted for the remote OS).
type Uploader interface {
	Upload(ctx context.Context, localPath string) (remoteAbspath string, err error)
}

// HTTPUploader talks to the local kari-syncd daemon over its
// 127.0.0.1:46321 HTTP API. The daemon does the copy/sync/wait dance;
// this client just POSTs and resolves the absolute path. RemoteWorkDir
// is shared with the kari pty main loop — the recv goroutine atomic-
// stores it on the first MessagePtyStart echo from the server.
type HTTPUploader struct {
	Base          string
	HTTP          *http.Client
	RemoteWorkDir *atomic.Pointer[string]
	// WorkDirTimeout caps how long Upload waits for RemoteWorkDir to
	// be populated. The server echoes MessagePtyStart back as the
	// first message after handshake, which should arrive well under
	// 100 ms; 3 s is the "something's wrong" cutoff. Zero means use
	// the default.
	WorkDirTimeout time.Duration
}

// ErrWorkDirUnknown is returned when the server hasn't told us the
// remote workspace cwd within the allotted window. The Sniffer treats
// it as a non-fatal upload failure and forwards the original paste.
var ErrWorkDirUnknown = errors.New("remote work_dir not yet known")

// Upload POSTs local_path to /v1/pty-attach, waits for the daemon to
// confirm sync, then stitches the wire-form rel onto the remote
// work_dir using the right separator for the server OS.
func (u HTTPUploader) Upload(ctx context.Context, localPath string) (string, error) {
	body, err := json.Marshal(map[string]string{"local_path": localPath})
	if err != nil {
		return "", err
	}
	base := strings.TrimRight(u.Base, "/")
	if base == "" {
		base = "http://127.0.0.1:46321"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/pty-attach", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	client := u.HTTP
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("pty-attach: %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
	}
	var parsed struct {
		RemoteRelpath string `json:"remote_relpath"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("pty-attach: parse response: %w", err)
	}
	if parsed.RemoteRelpath == "" {
		return "", fmt.Errorf("pty-attach: empty remote_relpath")
	}

	workDir, err := u.waitForWorkDir(ctx)
	if err != nil {
		return "", err
	}
	return joinRemotePath(workDir, parsed.RemoteRelpath), nil
}

// waitForWorkDir polls the atomic pointer until the recv loop stores
// the server-echoed work_dir. The handshake echo typically lands
// instantly, so the loop almost always returns on the first iteration.
func (u HTTPUploader) waitForWorkDir(ctx context.Context) (string, error) {
	if u.RemoteWorkDir == nil {
		return "", ErrWorkDirUnknown
	}
	if ptr := u.RemoteWorkDir.Load(); ptr != nil && *ptr != "" {
		return *ptr, nil
	}
	timeout := u.WorkDirTimeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	deadline := time.Now().Add(timeout)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-tick.C:
		}
		if ptr := u.RemoteWorkDir.Load(); ptr != nil && *ptr != "" {
			return *ptr, nil
		}
		if time.Now().After(deadline) {
			return "", ErrWorkDirUnknown
		}
	}
}

// joinRemotePath stitches a wire-form (forward-slash) rel onto an OS-
// native work_dir. The trick is detecting whether the server is
// Windows: trans-server's req.WorkDir comes from filepath.Join under
// the server's OS, so a Windows server produces strings like
// `C:\Users\kari\workspaces\wid\name` and a POSIX server produces
// `/var/lib/trans/workspaces/wid/name`. The drive-letter prefix is a
// reliable Windows tell.
//
// We deliberately don't import path/filepath because that uses the
// *client's* OS for separator decisions — the wrong axis. Instead we
// branch on the work_dir shape and pick separators by hand.
func joinRemotePath(workDir, wireRel string) string {
	rel := strings.TrimPrefix(wireRel, "/")
	if isWindowsAbs(workDir) {
		nativeRel := strings.ReplaceAll(rel, "/", "\\")
		base := strings.TrimRight(workDir, "\\/")
		return base + "\\" + nativeRel
	}
	return path.Join(workDir, rel)
}

// isWindowsAbs reports whether p looks like a Windows absolute path
// (drive letter + colon + sep). UNC paths (`\\host\share\...`) also
// qualify; treated as Windows here.
func isWindowsAbs(p string) bool {
	if strings.HasPrefix(p, `\\`) {
		return true
	}
	if len(p) < 3 {
		return false
	}
	c := p[0]
	if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
		return false
	}
	return p[1] == ':' && (p[2] == '\\' || p[2] == '/')
}
