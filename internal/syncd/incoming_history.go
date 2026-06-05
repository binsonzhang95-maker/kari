package syncd

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	incomingHistoryDir       = ".kari-engine/incoming-history"
	incomingHistoryIndexFile = "index.json"
)

// var (not const) so tests can shrink them to exercise eviction
// without writing 100 MB of fixtures.
var (
	// Per-snapshot cap so one giant binary can't blow the entire
	// budget on a single file. The QuickDiffProvider degrades to "no
	// gutter bars for this file" when no pre-image exists, which is
	// the right behaviour for huge blobs no human is gutter-diffing
	// anyway.
	incomingHistoryMaxBytesPerEntry int64 = 5 * 1024 * 1024
	// Total disk budget across all entries for one workspace.
	// Eviction is oldest-first when exceeded.
	incomingHistoryTotalBudget int64 = 100 * 1024 * 1024
)

// incomingHistoryEntry is the per-file index record persisted in
// index.json. Keyed in memory by Rel; SHA is the on-disk filename
// for the actual pre-image bytes.
type incomingHistoryEntry struct {
	Rel  string `json:"rel"`
	SHA  string `json:"sha"`
	TS   int64  `json:"ts"`
	Size int64  `json:"size"`
}

// IncomingHistory is the daemon-side disk-backed implementation of
// filesync.IncomingHistoryStore. One instance per bound workspace,
// stored under <workspaceRoot>/.kari-engine/incoming-history/.
//
// Stores only the LATEST pre-image per file — that's what the VS Code
// QuickDiffProvider needs to render the "what did the last sync
// change" gutter bars. Multi-version history would be a separate,
// fancier feature.
type IncomingHistory struct {
	root    string
	mu      sync.RWMutex
	entries map[string]*incomingHistoryEntry
	total   int64
}

// NewIncomingHistory returns a store rooted under workspaceRoot. Loads
// any prior index from disk so pre-images survive daemon restart.
// Returns nil if the storage dir cannot be created; caller treats that
// as "history disabled" and continues without snapshotting (the diff
// feature simply won't render gutter bars).
func NewIncomingHistory(workspaceRoot string) *IncomingHistory {
	dir := filepath.Join(workspaceRoot, incomingHistoryDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("incoming-history: mkdir %s: %v (disabled)", dir, err)
		return nil
	}
	h := &IncomingHistory{
		root:    dir,
		entries: map[string]*incomingHistoryEntry{},
	}
	h.loadIndex()
	return h
}

// Snapshot stores content as the latest pre-image for rel. Replaces
// any prior snapshot for the same rel. content==nil is fine and
// records a zero-byte pre-image (so the diff view shows the file as
// "all new"). Files larger than incomingHistoryMaxBytesPerEntry are
// silently skipped (return nil) — the diff view will simply not show
// gutter bars for that file, which beats evicting half the index for
// one giant blob.
func (h *IncomingHistory) Snapshot(rel string, content []byte) error {
	if int64(len(content)) > incomingHistoryMaxBytesPerEntry {
		return nil
	}
	sha := relSHA(rel)
	blobPath := filepath.Join(h.root, sha+".bin")

	h.mu.Lock()
	defer h.mu.Unlock()

	var oldSize int64
	if prev, ok := h.entries[rel]; ok {
		oldSize = prev.Size
	}
	newSize := int64(len(content))

	tmp := blobPath + ".tmp"
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, blobPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}

	h.entries[rel] = &incomingHistoryEntry{
		Rel:  rel,
		SHA:  sha,
		TS:   time.Now().UnixNano(),
		Size: newSize,
	}
	h.total += newSize - oldSize
	h.evictLocked()
	h.persistIndexLocked()
	return nil
}

// Get returns the latest pre-image bytes for rel, if any. The bool is
// false when no snapshot exists (file was never overwritten by a
// remote sync, or eviction kicked it out).
func (h *IncomingHistory) Get(rel string) ([]byte, bool) {
	h.mu.RLock()
	e, ok := h.entries[rel]
	h.mu.RUnlock()
	if !ok {
		return nil, false
	}
	data, err := os.ReadFile(filepath.Join(h.root, e.SHA+".bin"))
	if err != nil {
		return nil, false
	}
	return data, true
}

// evictLocked drops oldest-first until total <= budget. Caller must
// hold h.mu (write).
func (h *IncomingHistory) evictLocked() {
	if h.total <= incomingHistoryTotalBudget {
		return
	}
	list := make([]*incomingHistoryEntry, 0, len(h.entries))
	for _, e := range h.entries {
		list = append(list, e)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].TS < list[j].TS })
	for _, e := range list {
		if h.total <= incomingHistoryTotalBudget {
			break
		}
		_ = os.Remove(filepath.Join(h.root, e.SHA+".bin"))
		delete(h.entries, e.Rel)
		h.total -= e.Size
	}
}

func (h *IncomingHistory) loadIndex() {
	data, err := os.ReadFile(filepath.Join(h.root, incomingHistoryIndexFile))
	if err != nil {
		return
	}
	var raw []incomingHistoryEntry
	if err := json.Unmarshal(data, &raw); err != nil {
		return
	}
	for i := range raw {
		e := raw[i]
		// Drop index entries whose blob got nuked outside our control
		// (manual rm, partial restore from backup). Otherwise Get()
		// would return false anyway and the index would lie about
		// total size budget calculations.
		if _, err := os.Stat(filepath.Join(h.root, e.SHA+".bin")); err != nil {
			continue
		}
		h.entries[e.Rel] = &e
		h.total += e.Size
	}
}

func (h *IncomingHistory) persistIndexLocked() {
	list := make([]*incomingHistoryEntry, 0, len(h.entries))
	for _, e := range h.entries {
		list = append(list, e)
	}
	data, err := json.Marshal(list)
	if err != nil {
		log.Printf("incoming-history: marshal index: %v", err)
		return
	}
	tmp := filepath.Join(h.root, incomingHistoryIndexFile+".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("incoming-history: write index: %v", err)
		return
	}
	if err := os.Rename(tmp, filepath.Join(h.root, incomingHistoryIndexFile)); err != nil {
		log.Printf("incoming-history: rename index: %v", err)
	}
}

func relSHA(rel string) string {
	sum := sha256.Sum256([]byte(rel))
	return hex.EncodeToString(sum[:])
}
