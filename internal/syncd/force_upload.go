package syncd

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

var forceAllowRequestTimeout = 15 * time.Second

func (s *Service) ForceUpload(ctx context.Context, paths []string) (int, error) {
	root := s.workspaceRootSnapshot()
	if root == "" {
		return 0, errors.New("daemon is not bound to a workspace")
	}
	entriesByPath := map[string]filesync.ForceAllowEntry{}
	for _, p := range paths {
		entry, err := filesync.ForceAllowEntryForPath(root, p)
		if err != nil {
			return 0, err
		}
		entriesByPath[entry.Path] = entry
	}
	if len(entriesByPath) == 0 {
		return 0, errors.New("paths are required")
	}
	entries := make([]filesync.ForceAllowEntry, 0, len(entriesByPath))
	for _, entry := range entriesByPath {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Path < entries[j].Path
	})

	s.mu.Lock()
	sess := s.activeSession
	s.mu.Unlock()
	if sess == nil {
		return 0, errors.New("no active sync session — wait for connection then retry")
	}

	ch, err := sess.RequestForceAllow(transport.ForceAllowRequest{Entries: entries})
	if err != nil {
		return 0, err
	}
	timer := time.NewTimer(forceAllowRequestTimeout)
	defer timer.Stop()
	select {
	case res := <-ch:
		if !res.OK {
			if strings.TrimSpace(res.Error) != "" {
				return 0, errors.New(res.Error)
			}
			return 0, errors.New("server rejected force upload")
		}
	case <-ctx.Done():
		sess.ClearForceAllowWaiter()
		return 0, ctx.Err()
	case <-timer.C:
		sess.ClearForceAllowWaiter()
		return 0, errors.New("timed out waiting for server to allow force upload")
	}

	count, err := sess.AddForceAllowEntries(entries)
	if err != nil {
		return 0, err
	}
	if count == 0 {
		return 0, errors.New("no valid force-upload paths")
	}
	if err := s.TriggerSync(); err != nil {
		return count, err
	}
	return count, nil
}
