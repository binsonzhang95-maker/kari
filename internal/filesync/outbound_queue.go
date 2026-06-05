package filesync

import (
	"sort"
	"sync"
	"sync/atomic"
)

type outboundTaskKind int

const (
	outboundSendPath outboundTaskKind = iota
	outboundForcedSend
	outboundForcedDelete
)

type outboundTask struct {
	kind        outboundTaskKind
	path        string
	info        FileInfo
	bypassPause bool
}

// outboundQueue models outbound sync work as a set of paths, not a FIFO.
// Repeated events for the same path coalesce, and send/delete are mutually
// exclusive: the last enqueue for a path wins.
type outboundQueue struct {
	mu      sync.Mutex
	pending map[string]outboundTask
	wake    chan struct{}
	// paused is the kill-switch for ALL upload-direction tasks. Set
	// when the session detects "peer workspace empty but I have files"
	// or "repo URL mismatch" — drops new enqueues silently rather than
	// pushing the wrong content. Inbound (receive) is unaffected; it
	// doesn't go through this queue. Re-enqueue happens automatically
	// the next time the peer's manifest exchange or a local rescan
	// re-derives the work, so the silent drop is recoverable.
	paused atomic.Bool
}

func newOutboundQueue() *outboundQueue {
	return &outboundQueue{
		pending: map[string]outboundTask{},
		wake:    make(chan struct{}, 1),
	}
}

func (q *outboundQueue) setPaused(p bool) {
	q.paused.Store(p)
}

func (q *outboundQueue) isPaused() bool {
	return q.paused.Load()
}

func (q *outboundQueue) enqueue(task outboundTask) {
	if q.paused.Load() && !task.bypassPause {
		return
	}
	path := cleanRel(task.path)
	if path == "" || path == "." {
		return
	}
	task.path = path
	if task.info.Path == "" {
		task.info.Path = path
	}

	q.mu.Lock()
	q.pending[path] = task
	q.mu.Unlock()

	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *outboundQueue) drain() []outboundTask {
	q.mu.Lock()
	if len(q.pending) == 0 {
		q.mu.Unlock()
		return nil
	}
	pending := q.pending
	q.pending = map[string]outboundTask{}
	q.mu.Unlock()

	batch := make([]outboundTask, 0, len(pending))
	for _, task := range pending {
		batch = append(batch, task)
	}
	sort.Slice(batch, func(i, j int) bool {
		return batch[i].path < batch[j].path
	})
	return batch
}

func (q *outboundQueue) pendingSize() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.pending)
}

// clear drops every queued path without firing the wake. Used by the
// session's MessageCancelDownload handler to short-circuit any pending
// outbound work for a workspace the peer has cancelled; sendLoop's
// drainOutbound will see the next drain return empty and idle out.
// Does NOT cancel the file currently being streamed by sendFile —
// that's the outboundCtx cancel path's job.
func (q *outboundQueue) clear() {
	q.mu.Lock()
	if len(q.pending) > 0 {
		q.pending = map[string]outboundTask{}
	}
	q.mu.Unlock()
}
