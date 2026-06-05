// Package gitutil exposes the tiny subset of git-config parsing the
// daemon needs without pulling in a real git library. Only the
// [remote "origin"] url is read; no fetch, no refs, no auth handling.
package gitutil

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// RemoteOriginURL finds the git directory for root (walking upward the
// same way git does, and supporting worktree/submodule .git files), then
// returns the [remote "origin"] url value. Returns "" if there's no git
// repository, no origin remote, or the config can't be read; callers can
// safely treat empty string as "no remote known."
func RemoteOriginURL(root string) string {
	gitDir := findGitDir(root)
	if gitDir == "" {
		return ""
	}
	for _, cfgPath := range gitConfigPaths(gitDir) {
		if u := remoteOriginURLFromConfig(cfgPath); u != "" {
			return u
		}
	}
	return ""
}

func remoteOriginURLFromConfig(path string) string {
	cfg, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var inOrigin bool
	for _, line := range strings.Split(string(cfg), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			inOrigin = isOriginRemoteSection(trimmed)
			continue
		}
		if !inOrigin {
			continue
		}
		key, value, ok := strings.Cut(trimmed, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), "url") {
			continue
		}
		return strings.TrimSpace(value)
	}
	return ""
}

func gitConfigPaths(gitDir string) []string {
	paths := []string{filepath.Join(gitDir, "config")}
	data, err := os.ReadFile(filepath.Join(gitDir, "commondir"))
	if err != nil {
		return paths
	}
	commonDir := strings.TrimSpace(strings.Split(string(data), "\n")[0])
	if commonDir == "" {
		return paths
	}
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(gitDir, commonDir)
	}
	commonConfig := filepath.Join(filepath.Clean(commonDir), "config")
	if commonConfig != paths[0] {
		paths = append(paths, commonConfig)
	}
	return paths
}

func findGitDir(root string) string {
	dir := filepath.Clean(strings.TrimSpace(root))
	if dir == "" || dir == "." {
		return ""
	}
	for {
		gitPath := filepath.Join(dir, ".git")
		if info, err := os.Stat(gitPath); err == nil && info.IsDir() {
			return gitPath
		}
		if data, err := os.ReadFile(gitPath); err == nil {
			if gitDir := parseGitDirFile(dir, data); gitDir != "" {
				return gitDir
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func parseGitDirFile(worktreeDir string, data []byte) string {
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), "gitdir") {
			continue
		}
		gitDir := strings.TrimSpace(value)
		if gitDir == "" {
			return ""
		}
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(worktreeDir, gitDir)
		}
		return filepath.Clean(gitDir)
	}
	return ""
}

func isOriginRemoteSection(line string) bool {
	if !strings.HasSuffix(line, "]") {
		return false
	}
	section := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
	section = strings.Join(strings.Fields(section), " ")
	return strings.EqualFold(section, `remote "origin"`) || strings.EqualFold(section, "remote.origin")
}

// RepoLockURL reads <root>/.kari-engine/repo-lock.json, written by
// server-side bootstrap after a successful git clone, and returns the
// stored remote URL. The bool reports whether the lock file exists
// and parses — distinct from "exists but URL is empty," though both
// collapse to the same caller-side outcome today.
func RepoLockURL(root string) (string, bool) {
	data, err := os.ReadFile(filepath.Join(root, ".kari-engine", "repo-lock.json"))
	if err != nil {
		return "", false
	}
	var lock struct {
		RemoteURL string `json:"remote_url"`
	}
	if err := json.Unmarshal(data, &lock); err != nil || lock.RemoteURL == "" {
		return "", false
	}
	return lock.RemoteURL, true
}

// WorkspaceRepoURL is the "best available" remote identity for the
// workspace at root: prefer the live .git/config (operational reality
// — what the user is actually pushing/pulling against) and fall back
// to repo-lock.json (what bootstrap intended to put here). Returns ""
// if neither is available.
func WorkspaceRepoURL(root string) string {
	if u := RemoteOriginURL(root); u != "" {
		return u
	}
	if u, ok := RepoLockURL(root); ok {
		return u
	}
	return ""
}
