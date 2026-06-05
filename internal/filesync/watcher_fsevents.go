//go:build darwin && cgo

package filesync

import (
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsevents"
)

// fseventsWatcher is the darwin implementation backed by FSEvents.
// FSEvents subscribes once to the root and the kernel walks the tree
// itself — no per-file FD, no recursive Add() bookkeeping, no kqueue
// 256-fd ceiling. The runtime cost is a fixed-size kernel buffer per
// stream regardless of how many files live under root.
//
// Latency below is the coalescing window. 250ms balances "user saved
// a file and expects the sync indicator to twitch" against "a build
// touched 5000 files and we want them as one batch, not one event each".
type fseventsWatcher struct {
	engine   *Engine
	stream   *fsevents.EventStream
	out      chan string
	errs     chan error
	stopOnce sync.Once
	done     chan struct{}
}

func newPlatformWatcher(e *Engine) (platformWatcher, error) {
	root := e.root
	dev, err := fsevents.DeviceForPath(root)
	if err != nil {
		return nil, err
	}
	// FileEvents flag is the whole reason we chose FSEvents — it makes
	// the kernel report per-file paths (Created/Modified/Removed) instead
	// of "something in this directory changed, go rescan." Without it,
	// we'd be back to walking dirs on every event, defeating the purpose.
	es := &fsevents.EventStream{
		Paths:   []string{root},
		Latency: 250 * time.Millisecond,
		Device:  dev,
		Flags:   fsevents.FileEvents,
	}
	if err := es.Start(); err != nil {
		return nil, err
	}
	w := &fseventsWatcher{
		engine: e,
		stream: es,
		out:    make(chan string, watcherEventBuffer),
		errs:   make(chan error, 16),
		done:   make(chan struct{}),
	}
	go w.pump(root)
	return w, nil
}

// pump translates FSEvents batches into per-path emissions on out.
// Event.Path comes device-relative ("Users/kari/...") when we set
// Device on the stream; we prepend "/" so downstream code receives the
// same absolute paths fsnotify would have produced. Drops events on
// channel overflow rather than blocking. The session-level outbound queue
// has path-set semantics, and the rescan ticker is the correctness backup,
// so overflow degrades to later detection rather than permanent loss.
func (w *fseventsWatcher) pump(root string) {
	defer close(w.out)
	for {
		// Two ways out: Close() closes w.done (immediate, deterministic)
		// or the underlying fsevents stream closes Events (which Stop()
		// is meant to trigger but doesn't always do promptly on darwin —
		// the CGO callback drains asynchronously). Without the explicit
		// w.done branch, the pump goroutine survives Close() until the
		// stream finally drains, which is the leak the goroutine-count
		// regression test catches.
		var batch []fsevents.Event
		select {
		case <-w.done:
			return
		case b, ok := <-w.stream.Events:
			if !ok {
				return
			}
			batch = b
		}
		for _, ev := range batch {
			path := ev.Path
			if !strings.HasPrefix(path, "/") {
				path = "/" + path
			}
			// FSEvents reports the device-relative path; verify the
			// event actually lives under our root before forwarding.
			// Mostly defensive — the stream is rooted at `root` so this
			// should always be true — but a future change to watch
			// multiple roots would need this filter anyway.
			if !strings.HasPrefix(path, root) {
				continue
			}
			// Defensively clean to drop any trailing slash FSEvents may
			// emit on directory paths; the downstream consumer uses
			// filepath.Rel + os.Stat which both prefer canonical forms.
			path = filepath.Clean(path)
			select {
			case w.out <- path:
			case <-w.done:
				return
			default:
				// Buffer full; drop. The rescan ticker will catch
				// anything missed here.
				w.engine.watcherEventDroppedTotal.Add(1)
			}
		}
	}
}

func (w *fseventsWatcher) Events() <-chan string { return w.out }
func (w *fseventsWatcher) Errors() <-chan error  { return w.errs }

func (w *fseventsWatcher) Close() error {
	w.stopOnce.Do(func() {
		close(w.done)
		w.stream.Stop() // closes w.stream.Events, which terminates pump
	})
	return nil
}
