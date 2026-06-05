package filesync

import (
	"errors"
	"log"
	"os"
)

// IncomingHistoryStore receives the bytes of a file just before an
// inbound sync overwrites or deletes it. The daemon side wires a
// disk-backed implementation so the VS Code extension can render
// gutter diff bars (red/green lines) against the pre-image. The
// trans-server leaves this nil — server-side has no UI consumer and
// snapshotting every overwrite would burn pointless I/O.
//
// content == nil means the local file did not exist before this apply
// (a remote create); implementations may record an empty pre-image so
// the diff view shows "everything is new" rather than appearing absent.
type IncomingHistoryStore interface {
	Snapshot(rel string, content []byte) error
}

// SetIncomingHistoryStore installs the pre-image hook. Pass nil to
// disable (server-side default). Safe to call before sessions start;
// not safe to swap mid-session.
func (e *Engine) SetIncomingHistoryStore(store IncomingHistoryStore) {
	e.incomingHistory = store
}

// snapshotPreImage reads the current bytes at target and hands them to
// the configured store. Called from the receive paths immediately
// before the on-disk content is mutated. Failures are logged and
// swallowed: snapshotting is observability, never the gate on whether
// a sync apply succeeds. ENOENT is treated as "file did not exist
// locally" and forwarded as nil content so the store can record a
// "create" marker if it cares to distinguish.
func (e *Engine) snapshotPreImage(rel, target string) {
	if e.incomingHistory == nil {
		return
	}
	content, err := os.ReadFile(target)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("incoming-history: read %s: %v (skipping snapshot)", rel, err)
			return
		}
		content = nil
	}
	if err := e.incomingHistory.Snapshot(rel, content); err != nil {
		log.Printf("incoming-history: snapshot %s: %v", rel, err)
	}
}
