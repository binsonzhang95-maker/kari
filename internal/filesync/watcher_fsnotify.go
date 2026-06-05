//go:build !darwin || !cgo

package filesync

import (
	"log"
	"os"
	"path/filepath"

	"github.com/fsnotify/fsnotify"
)

// fsnotifyWatcher backs Linux (inotify) and Windows (ReadDirectoryChangesW),
// plus CGO-disabled darwin builds. Release macOS kari-syncd should be
// built with CGO_ENABLED=1 so it uses FSEvents instead; the fsnotify
// darwin fallback is kept for source-level/debug builds where cgo is
// deliberately unavailable.
//
// Behaviour mirrors the pre-refactor Watch() inline code: walk the
// workspace once to add every non-ignored dir, and on each Create-of-dir
// event walk that subtree to add the newly-spawned dirs. Without the
// recursive Add, sub-directories created after startup wouldn't be
// watched at all — fsnotify on Linux doesn't auto-descend.
type fsnotifyWatcher struct {
	engine *Engine
	w      *fsnotify.Watcher
	out    chan string
	errs   chan error
	done   chan struct{}
}

func newPlatformWatcher(e *Engine) (platformWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	fw := &fsnotifyWatcher{
		engine: e,
		w:      w,
		out:    make(chan string, watcherEventBuffer),
		errs:   make(chan error, 16),
		done:   make(chan struct{}),
	}
	if err := fw.addWatchDirs(); err != nil {
		w.Close()
		return nil, err
	}
	go fw.pump()
	return fw, nil
}

func (fw *fsnotifyWatcher) pump() {
	defer close(fw.out)
	defer close(fw.errs)
	for {
		select {
		case <-fw.done:
			return
		case event, ok := <-fw.w.Events:
			if !ok {
				return
			}
			// Mirror the old engine.Watch logic: when a new directory
			// appears, register it (and anything already inside it on
			// disk) so subsequent edits land as events instead of being
			// silently missed until the next rescan.
			//
			// The ignoreMatcher check mirrors addWatchDirs: without it,
			// a runtime `npm install` / `cargo build` that creates a
			// new node_modules / target/ would recursively Add every
			// inner directory and flood the watcher buffer with events
			// the session layer would just throw away. The initial
			// startup walk already prunes these subtrees; the same rule
			// has to apply to dirs created after startup.
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					matcher := fw.engine.ignoreMatcher()
					forceAllow := fw.engine.forceAllowSnapshot()
					rel, rerr := fw.engine.relative(event.Name)
					skip := rerr != nil || shouldSkipDirWithMatcher(rel, matcher, forceAllow)
					if !skip {
						_ = filepath.WalkDir(event.Name, func(p string, d os.DirEntry, werr error) error {
							if werr != nil || !d.IsDir() {
								return nil
							}
							if subRel, subErr := fw.engine.relative(p); subErr == nil {
								if shouldSkipDirWithMatcher(subRel, matcher, forceAllow) {
									return filepath.SkipDir
								}
							}
							_ = fw.w.Add(p)
							return nil
						})
					}
				}
			}
			select {
			case fw.out <- event.Name:
			case <-fw.done:
				return
			default:
				// Buffer overflow. The session-level outbound queue is
				// path-set based, and the rescan ticker will recover.
				fw.engine.watcherEventDroppedTotal.Add(1)
			}
		case err, ok := <-fw.w.Errors:
			if !ok {
				return
			}
			select {
			case fw.errs <- err:
			case <-fw.done:
				return
			default:
			}
		}
	}
}

// addWatchDirs walks the workspace and registers each non-ignored
// directory with fsnotify. Per-directory failures (EACCES on a stat,
// EMFILE / ENOSPC on watcher.Add when the kernel watch quota is hit)
// are logged and skipped rather than aborted — otherwise a single bad
// entry would leave every later directory in the walk un-watched, and
// the affected workspace silently degrades to rescan-only delivery
// (30s lag) for files in those subtrees. Skipping ignored / internal
// subtrees keeps the watcher's kernel buffer footprint bounded — on
// Windows each directory handle is a separate ReadDirectoryChangesW
// allocation.
func (fw *fsnotifyWatcher) addWatchDirs() error {
	e := fw.engine
	matcher := e.ignoreMatcher()
	forceAllow := e.forceAllowSnapshot()
	return filepath.WalkDir(e.root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			if path == e.root {
				return err
			}
			log.Printf("watch walk %s: %v (skipping subtree, will rely on rescan)", path, err)
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		rel, rerr := e.relative(path)
		if rerr == nil && rel != "" {
			if shouldSkipDirWithMatcher(rel, matcher, forceAllow) {
				return filepath.SkipDir
			}
		}
		if addErr := fw.w.Add(path); addErr != nil {
			log.Printf("watch add %s: %v (continuing; this directory falls back to rescan)", path, addErr)
		}
		return nil
	})
}

func (fw *fsnotifyWatcher) Events() <-chan string { return fw.out }
func (fw *fsnotifyWatcher) Errors() <-chan error  { return fw.errs }

func (fw *fsnotifyWatcher) Close() error {
	select {
	case <-fw.done:
		return nil
	default:
		close(fw.done)
	}
	return fw.w.Close()
}
