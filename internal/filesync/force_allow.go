package filesync

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

type ForceAllowEntry = transport.ForceAllowEntry

type forceAllowFile struct {
	Version int               `json:"version"`
	Entries []ForceAllowEntry `json:"entries"`
}

var ErrForceAllowPath = errors.New("invalid force-upload path")

func (e *Engine) forceAllowPath() string {
	return filepath.Join(e.root, internalStateDirName, "force-sync.json")
}

func (e *Engine) loadForceAllow() error {
	data, err := os.ReadFile(e.forceAllowPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var f forceAllowFile
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	if len(f.Entries) == 0 {
		return nil
	}
	e.mu.Lock()
	for _, entry := range f.Entries {
		if normalized, ok := normalizeForceAllowEntry(entry); ok {
			e.forceAllow[normalized.Path] = normalized
		}
	}
	e.mu.Unlock()
	return nil
}

func (e *Engine) AddForceAllowEntries(entries []ForceAllowEntry) (int, error) {
	normalized := make([]ForceAllowEntry, 0, len(entries))
	for _, entry := range entries {
		if n, ok := normalizeForceAllowEntry(entry); ok {
			normalized = append(normalized, n)
		}
	}
	if len(normalized) == 0 {
		return 0, nil
	}
	e.mu.Lock()
	changed := false
	for _, entry := range normalized {
		if cur, ok := e.forceAllow[entry.Path]; !ok || cur.Dir != entry.Dir {
			e.forceAllow[entry.Path] = entry
			changed = true
		}
	}
	e.mu.Unlock()
	if changed {
		e.persistForceAllowNow()
	}
	return len(normalized), nil
}

func (e *Engine) ForceAllowEntries() []ForceAllowEntry {
	entries := e.forceAllowSnapshot()
	sortForceAllow(entries)
	return entries
}

func (e *Engine) isForceAllowed(rel string, isDir bool) bool {
	return forceAllowMatches(e.forceAllowSnapshot(), rel, isDir)
}

func (e *Engine) forceAllowSnapshot() []ForceAllowEntry {
	e.mu.Lock()
	defer e.mu.Unlock()
	entries := make([]ForceAllowEntry, 0, len(e.forceAllow))
	for _, entry := range e.forceAllow {
		entries = append(entries, entry)
	}
	return entries
}

func normalizeForceAllowEntry(entry ForceAllowEntry) (ForceAllowEntry, bool) {
	rel := cleanRel(entry.Path)
	if rel == "" || rel == "." || relEscapesRoot(rel) || filepath.IsAbs(rel) {
		return ForceAllowEntry{}, false
	}
	if isInternalStatePath(rel) {
		return ForceAllowEntry{}, false
	}
	return ForceAllowEntry{Path: rel, Dir: entry.Dir}, true
}

func relEscapesRoot(rel string) bool {
	r := filepath.ToSlash(rel)
	return r == ".." || strings.HasPrefix(r, "../")
}

func forceAllowMatches(entries []ForceAllowEntry, rel string, isDir bool) bool {
	rel = cleanRel(rel)
	for _, entry := range entries {
		p := cleanRel(entry.Path)
		if entry.Dir {
			if rel == p || strings.HasPrefix(rel, p+"/") {
				return true
			}
			continue
		}
		if !isDir && rel == p {
			return true
		}
	}
	return false
}

func forceAllowShouldDescend(entries []ForceAllowEntry, rel string) bool {
	rel = cleanRel(rel)
	for _, entry := range entries {
		p := cleanRel(entry.Path)
		if rel == p || strings.HasPrefix(p, rel+"/") {
			return true
		}
	}
	return false
}

func (e *Engine) persistForceAllowNow() {
	if !e.rootAccessible() {
		return
	}
	e.mu.Lock()
	entries := make([]ForceAllowEntry, 0, len(e.forceAllow))
	for _, entry := range e.forceAllow {
		entries = append(entries, entry)
	}
	e.mu.Unlock()
	sortForceAllow(entries)

	e.forceAllowWriteMu.Lock()
	defer e.forceAllowWriteMu.Unlock()

	dir := filepath.Dir(e.forceAllowPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("filesync: mkdir force allow dir: %v", err)
		return
	}
	data, err := json.Marshal(forceAllowFile{Version: 1, Entries: entries})
	if err != nil {
		log.Printf("filesync: marshal force allow: %v", err)
		return
	}
	tmp := e.forceAllowPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("filesync: write force allow: %v", err)
		return
	}
	if err := os.Rename(tmp, e.forceAllowPath()); err != nil {
		log.Printf("filesync: rename force allow: %v", err)
	}
}

func sortForceAllow(entries []ForceAllowEntry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Path == entries[j].Path {
			return !entries[i].Dir && entries[j].Dir
		}
		return entries[i].Path < entries[j].Path
	})
}

func ForceAllowEntryForPath(root, localPath string) (ForceAllowEntry, error) {
	if strings.TrimSpace(root) == "" || strings.TrimSpace(localPath) == "" {
		return ForceAllowEntry{}, fmt.Errorf("%w: empty path", ErrForceAllowPath)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return ForceAllowEntry{}, fmt.Errorf("%w: root: %v", ErrForceAllowPath, err)
	}
	evalRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return ForceAllowEntry{}, fmt.Errorf("%w: root: %v", ErrForceAllowPath, err)
	}
	absPath, err := filepath.Abs(localPath)
	if err != nil {
		return ForceAllowEntry{}, fmt.Errorf("%w: %v", ErrForceAllowPath, err)
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return ForceAllowEntry{}, fmt.Errorf("%w: %v", ErrForceAllowPath, err)
	}
	evalPath, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		return ForceAllowEntry{}, fmt.Errorf("%w: %v", ErrForceAllowPath, err)
	}
	rel, err := filepath.Rel(evalRoot, evalPath)
	if err != nil {
		return ForceAllowEntry{}, fmt.Errorf("%w: %v", ErrForceAllowPath, err)
	}
	wireRel := cleanRel(rel)
	if wireRel == "." || relEscapesRoot(wireRel) || filepath.IsAbs(rel) {
		return ForceAllowEntry{}, fmt.Errorf("%w: outside workspace", ErrForceAllowPath)
	}
	if isInternalStatePath(wireRel) {
		return ForceAllowEntry{}, fmt.Errorf("%w: internal state path", ErrForceAllowPath)
	}
	return ForceAllowEntry{Path: wireRel, Dir: info.IsDir()}, nil
}
