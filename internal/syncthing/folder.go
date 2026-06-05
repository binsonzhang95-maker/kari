package syncthing

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

// FolderIDForWorkspaceID computes the canonical Syncthing folder_id
// from a Kari workspace_id, per migration §2.1:
//
//	folder_id = "kari1_" + slug(workspace_id) + "__" + shortsha256(workspace_id)
//
// where:
//   - `kari1_` is the algorithm version prefix (so future
//     algorithm changes can bump to `kari2_` without colliding).
//   - `slug` preserves [A-Za-z0-9._-] and replaces every other rune
//     with `_`. The output is trimmed so the full folder_id stays
//     under 96 chars.
//   - `shortsha256` is the first 12 hex chars of the SHA-256 of the
//     raw workspace_id bytes (NOT the slugged version — the hash
//     uniquely identifies the source even if multiple workspace_ids
//     slug to the same string).
//
// Pure function: same workspace_id always produces the same
// folder_id. By contract (migration §2.1) this function is computed
// IDENTICALLY by both server and client without coordination — the
// hello flow uses it on both sides to derive the folder_id before
// any handshake; the hello ack just sanity-checks they agree.
func FolderIDForWorkspaceID(workspaceID string) string {
	sum := sha256.Sum256([]byte(workspaceID))
	hash := hex.EncodeToString(sum[:])[:12]

	// Total budget = 96. Prefix "kari1_" = 6, separator "__" = 2,
	// hash = 12; leaves 76 for the slug.
	const maxSlug = 76
	slug := slugifyFolderID(workspaceID, maxSlug)

	var b strings.Builder
	b.Grow(6 + len(slug) + 2 + 12)
	b.WriteString("kari1_")
	b.WriteString(slug)
	b.WriteString("__")
	b.WriteString(hash)
	return b.String()
}

// folderIDAlgorithmVersion returns the algorithm version prefix this
// build emits. Exposed for callers that want to surface the version
// in a folder_id_algorithm_mismatch error payload.
func folderIDAlgorithmVersion() string {
	return "kari1"
}

// driveLetterPath matches the prefix of a Windows-style drive path
// (e.g. "C:/users/...") so the per-project folder ID validator can
// reject it as non-relative. We accept either / or \ as the separator
// after the colon since the rest of the function normalises \ → /.
var driveLetterPath = regexp.MustCompile(`^[a-zA-Z]:[\\/]`)

// FolderIDFor returns the per-project Syncthing folder_id for a
// workspace + project pair, per PTY-driven concurrent-sync plan T1/T2:
//
//	folder_id = "kari1_" + slug(wsid) + "__" + slug(projRel) + "__"
//	          + shortsha256(wsid + "\x1f" + canonicalProjRel)
//
// Each project under a workspace gets its own folder slot so the
// desktop can keep multiple projects syncing concurrently. The unit
// separator ensures (wsid="ws-A", projRel="B/C") and
// (wsid="ws-A/B", projRel="C") produce different hashes — without it
// their raw concatenations would coincide.
//
// projectRelPath is REQUIRED and non-empty. Returns
// folder_id_invalid_project_rel_path on:
//   - empty input (no silent regression to workspace-level FolderIDForWorkspaceID)
//   - absolute POSIX path / Windows drive path
//   - any ".." segment
//   - input that canonicalises to "" or "." (e.g. "./", "./.", ".//.")
//
// The canonical form is computed FIRST (\\→/, collapse //, strip ./
// prefix loop, strip trailing /); validators below then see the exact
// string that will be hashed. This catches edge cases like "./" that
// an early "starts with /" check would let through.
//
// Identical algorithm to packages/client desktop JS folderIdFor in
// kari-vibe-mobile/syncthing_pair.cjs — both sides derive the same
// folder_id without coordination.
func FolderIDFor(workspaceID, projectRelPath string) (string, error) {
	if workspaceID == "" {
		return "", fmt.Errorf("FolderIDFor: workspace_id is required")
	}
	if projectRelPath == "" {
		return "", fmt.Errorf("FolderIDFor: project_path is required (empty no longer supported — workspace-level sync is gone)")
	}

	canon := canonicalizeProjectRelPath(projectRelPath)
	if canon == "" || canon == "." {
		return "", fmt.Errorf("FolderIDFor: project_path resolved to empty after normalization")
	}
	if strings.HasPrefix(canon, "/") {
		return "", fmt.Errorf("FolderIDFor: project_path must be relative, not absolute")
	}
	if driveLetterPath.MatchString(canon) {
		return "", fmt.Errorf("FolderIDFor: project_path must be relative, not a drive path")
	}
	for _, seg := range strings.Split(canon, "/") {
		if seg == ".." {
			return "", fmt.Errorf("FolderIDFor: project_path must not contain %q segments", "..")
		}
	}

	// Budget = 96 total chars:
	//   "kari1_" (6) + wsSlug (≤30) + "__" (2) + projSlug (≤44) + "__" (2) + hash12 (12) = 96
	const (
		wsMax   = 30
		projMax = 44
	)

	sum := sha256.Sum256([]byte(workspaceID + "\x1f" + canon))
	hash := hex.EncodeToString(sum[:])[:12]

	wsSlug := slugifyFolderID(workspaceID, wsMax)
	projSlug := slugifyFolderID(canon, projMax)

	var b strings.Builder
	b.Grow(6 + len(wsSlug) + 2 + len(projSlug) + 2 + 12)
	b.WriteString("kari1_")
	b.WriteString(wsSlug)
	b.WriteString("__")
	b.WriteString(projSlug)
	b.WriteString("__")
	b.WriteString(hash)
	return b.String(), nil
}

// canonicalizeProjectRelPath normalises a project-relative path to its
// canonical form so equivalent inputs ("proj/", "./proj", "proj//sub")
// collapse to the same string before hashing. Order matters:
//
//  1. \ → /                       (Windows separators)
//  2. collapse runs of //          ("proj//sub" → "proj/sub")
//  3. strip "./" prefix loop      ("./proj" → "proj")
//  4. strip trailing / loop       ("proj/" → "proj")
//
// Pure — does not validate; the caller (FolderIDFor) checks the result.
func canonicalizeProjectRelPath(s string) string {
	canon := strings.ReplaceAll(s, "\\", "/")
	for strings.Contains(canon, "//") {
		canon = strings.ReplaceAll(canon, "//", "/")
	}
	for strings.HasPrefix(canon, "./") {
		canon = canon[2:]
	}
	for len(canon) > 1 && strings.HasSuffix(canon, "/") {
		canon = canon[:len(canon)-1]
	}
	return canon
}

// slugifyFolderID keeps only the URL-safe runes [A-Za-z0-9._-] and
// replaces everything else with `_`. Output is byte-truncated to
// `max` to keep the assembled folder_id under the 96-char total
// budget. Truncation cuts at the byte boundary; runes that span the
// boundary are dropped (rare in practice — workspace_ids are
// typically alphanumeric).
func slugifyFolderID(s string, max int) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z',
			r >= 'a' && r <= 'z',
			r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	if len(out) > max {
		out = out[:max]
	}
	return out
}
