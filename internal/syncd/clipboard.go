package syncd

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// clipboardTempDirName lives under os.TempDir() and holds short-lived
// PNG dumps of the user's clipboard captured for the "paste image"
// flow. Files older than clipboardRetention get swept by
// clipboardGCLoop. Kept under a single subdirectory so the cleanup
// pass doesn't have to scan all of /tmp.
const clipboardTempDirName = "kari-clipboard"

// clipboardRetention is how long a clip lingers before GC removes it.
// 24h is enough that a slow Cmd+V → sniffer → upload roundtrip on a
// flaky link still has its source file present at the end, while
// keeping /tmp from growing without bound.
const clipboardRetention = 24 * time.Hour

// ErrClipboardNoImage is the well-known sentinel for "the system
// clipboard does not currently hold a PNG-decodable image." The HTTP
// layer turns it into a 200 with has_image=false rather than an error
// — the extension's Cmd+V code path treats it as "fall through to
// normal paste."
var ErrClipboardNoImage = errors.New("clipboard does not contain an image")

// ReadClipboardImage queries the OS clipboard for a PNG image and, on
// hit, drops it into a temp file under os.TempDir()/kari-clipboard/.
// Returns the absolute local path the caller can hand to the kari pty
// sniffer (via terminal.sendText bracketed paste) which then uploads
// it through the existing /v1/pty-attach flow.
//
// Cross-platform via shell-out — keeping clipboard reads out of cgo
// land means our build script's CGO_ENABLED=0 still produces working
// binaries on every target. The per-OS commands all exit non-zero
// when the clipboard isn't an image, which we map to ErrClipboardNoImage.
func ReadClipboardImage(ctx context.Context) (string, error) {
	tmpRoot := clipboardTempRoot()
	if err := os.MkdirAll(tmpRoot, 0o755); err != nil {
		return "", fmt.Errorf("mkdir clipboard tmp: %w", err)
	}
	dst := filepath.Join(tmpRoot, "clip-"+strconv.FormatInt(time.Now().UnixNano(), 10)+".png")

	switch runtime.GOOS {
	case "darwin":
		if err := readClipboardImageDarwin(ctx, dst); err != nil {
			return "", err
		}
	case "windows":
		if err := readClipboardImageWindows(ctx, dst); err != nil {
			return "", err
		}
	case "linux":
		if err := readClipboardImageLinux(ctx, dst); err != nil {
			return "", err
		}
	default:
		return "", ErrClipboardNoImage
	}

	// Validate: the helper succeeded but produced an empty file means
	// "no PNG on clipboard" in some shells (osascript path takes this
	// shape). Treat as no-image and tidy up.
	if info, err := os.Stat(dst); err != nil || info.Size() == 0 {
		_ = os.Remove(dst)
		return "", ErrClipboardNoImage
	}
	return dst, nil
}

// clipboardTempRoot is the directory ReadClipboardImage writes into.
// Function (not const) so tests can swap it via the
// kariClipboardTempRoot env var — handy for not polluting the real
// /tmp during integration runs.
func clipboardTempRoot() string {
	if v := os.Getenv("KARI_CLIPBOARD_TMP"); v != "" {
		return v
	}
	return filepath.Join(os.TempDir(), clipboardTempDirName)
}

// readClipboardImageDarwin uses osascript to coerce the pasteboard
// to PNG data and dump it to disk. The «class PNGf» trick is the
// documented AppleScript form for the PNG flavor. When the clipboard
// holds anything else (text, files, unknown), osascript exits non-zero
// and we return ErrClipboardNoImage.
func readClipboardImageDarwin(ctx context.Context, dst string) error {
	script := fmt.Sprintf(`set thePath to %q
try
  set pngData to (the clipboard as «class PNGf»)
on error
  do shell script "exit 1"
end try
set f to open for access POSIX file thePath with write permission
try
  set eof of f to 0
  write pngData to f
  close access f
on error errMsg
  try
    close access f
  end try
  error errMsg
end try`, dst)
	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		_ = os.Remove(dst)
		if len(out) > 0 {
			// AppleScript fails loudly when the clipboard isn't an
			// image; that's our expected non-image signal — surface it
			// as the sentinel without dragging the noisy stderr along.
			return ErrClipboardNoImage
		}
		return ErrClipboardNoImage
	}
	return nil
}

// readClipboardImageWindows uses an inline PowerShell snippet built
// around System.Windows.Forms.Clipboard.GetImage(). Two gotchas the
// first cut got wrong and this version fixes:
//   1. -Sta is mandatory. The clipboard COM APIs throw or silently
//      return null when called from an MTA thread, which is
//      PowerShell's default. Without -Sta a real screenshot in the
//      clipboard would always look like "no image".
//   2. ContainsImage() first. GetImage() copies the entire bitmap
//      out even when there's nothing to copy (it returns null but
//      after doing the work); ContainsImage() short-circuits the
//      "user pasted text" path in microseconds.
//
// PowerShell's cold start (~500 ms on a warm box) is the slowest part
// of the whole Cmd+V flow on Windows — acceptable for v1, but if it
// stings we can switch to a Win32 syscall (IsClipboardFormatAvailable +
// GetClipboardData) which would land at <10 ms with no extra deps.
func readClipboardImageWindows(ctx context.Context, dst string) error {
	winPath := strings.ReplaceAll(dst, "/", `\`)
	script := `$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 1 }
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if ($null -eq $img) { exit 1 }
  try {
    $img.Save("` + winPath + `", [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $img.Dispose()
  }
} catch {
  exit 1
}`
	cmd := exec.CommandContext(ctx, "powershell",
		"-NoProfile", "-NonInteractive", "-Sta",
		"-ExecutionPolicy", "Bypass",
		"-Command", script)
	if err := cmd.Run(); err != nil {
		_ = os.Remove(dst)
		return ErrClipboardNoImage
	}
	return nil
}

// readClipboardImageLinux tries Wayland first (wl-paste, the modern
// default on Ubuntu 22+ etc) then X11 (xclip). Either is fine; we
// don't care which compositor the user runs. If neither tool is
// installed we return ErrClipboardNoImage so the extension just
// falls through to a regular text paste — printing a setup message
// would be too noisy for a feature the user might not be trying to
// use.
func readClipboardImageLinux(ctx context.Context, dst string) error {
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open dst: %w", err)
	}
	defer out.Close()

	// Wayland branch.
	if _, lookErr := exec.LookPath("wl-paste"); lookErr == nil {
		cmd := exec.CommandContext(ctx, "wl-paste", "--type", "image/png")
		cmd.Stdout = out
		if runErr := cmd.Run(); runErr == nil {
			return nil
		}
		// Reset for the xclip attempt; partial data would corrupt PNG.
		_ = out.Truncate(0)
		_, _ = out.Seek(0, 0)
	}
	// X11 branch.
	if _, lookErr := exec.LookPath("xclip"); lookErr == nil {
		cmd := exec.CommandContext(ctx, "xclip", "-selection", "clipboard", "-t", "image/png", "-o")
		cmd.Stdout = out
		if runErr := cmd.Run(); runErr == nil {
			return nil
		}
	}
	out.Close()
	_ = os.Remove(dst)
	return ErrClipboardNoImage
}

// clipboardGCLoop runs alongside the uploadsGCLoop and sweeps stale
// clipboard temp files. Tighter retention than uploads (24h vs 7d)
// because clipboard-temp files are scratch — once the sniffer has
// shipped one upstream the original is dead weight.
func (s *Service) clipboardGCLoop(ctx context.Context) {
	s.gcClipboardOnce()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.gcClipboardOnce()
		}
	}
}

func (s *Service) gcClipboardOnce() {
	dir := clipboardTempRoot()
	cutoff := time.Now().Add(-clipboardRetention)
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
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
				log.Printf("clipboard gc: remove %s: %v", p, rmErr)
			}
		}
		return nil
	})
}
