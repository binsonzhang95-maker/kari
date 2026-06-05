package filesync

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
)

type tombstoneFile struct {
	Version    int              `json:"version"`
	Tombstones map[string]int64 `json:"tombstones"`
}

// tombstonesPath is the on-disk JSON file persisting tombstones across
// daemon / server restarts. Without persistence, an "offline delete"
// gets undone on the next reconnect: the side that deleted the file
// has forgotten about it (no tombstone), the peer's manifest claims
// the file is alive, and we cheerfully resurrect it. Persistence
// closes that hole.
func (e *Engine) tombstonesPath() string {
	return filepath.Join(e.root, internalStateDirName, "tombstones.json")
}

func (e *Engine) loadTombstones() error {
	data, err := os.ReadFile(e.tombstonesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var tf tombstoneFile
	if err := json.Unmarshal(data, &tf); err != nil {
		return err
	}
	if tf.Tombstones == nil {
		return nil
	}
	e.mu.Lock()
	for p, t := range tf.Tombstones {
		e.tombstones[p] = t
	}
	e.mu.Unlock()
	return nil
}

// persistTombstones writes the current tombstone map atomically (tmp +
// rename). Called from within mutex-holding paths; takes its own short
// snapshot under the lock and writes after releasing it so disk IO
// doesn't extend the critical section.
//
// Same root-accessible gate as persistIndex: if e.root has vanished,
// skip the write rather than MkdirAll the workspace back into existence.
// See engine.go:rootAccessible() for the rationale.
func (e *Engine) persistTombstones() {
	if !e.rootAccessible() {
		return
	}
	e.mu.Lock()
	snap := make(map[string]int64, len(e.tombstones))
	for p, t := range e.tombstones {
		snap[p] = t
	}
	e.mu.Unlock()

	// Serialize the disk-write phase — see indexWriteMu rationale in
	// engine.go. Two parallel persistTombstones calls would otherwise
	// race on the `.tmp` path.
	e.tombstonesWriteMu.Lock()
	defer e.tombstonesWriteMu.Unlock()

	dir := filepath.Dir(e.tombstonesPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("filesync: mkdir tombstones dir: %v", err)
		return
	}
	tf := tombstoneFile{Version: 1, Tombstones: snap}
	data, err := json.Marshal(tf)
	if err != nil {
		log.Printf("filesync: marshal tombstones: %v", err)
		return
	}
	tmp := e.tombstonesPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("filesync: write tombstones: %v", err)
		return
	}
	if err := os.Rename(tmp, e.tombstonesPath()); err != nil {
		log.Printf("filesync: rename tombstones: %v", err)
	}
}
