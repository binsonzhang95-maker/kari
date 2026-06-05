package filesync

import (
	"encoding/json"
	"sort"
)

// FileInfo is the per-path payload that rides MessageManifest envelopes
// and also lives in Engine.index as the engine's cached view of disk
// state. Live files set Hash/Size/ModTime; tombstones set Deleted=true
// and use Version as the tombstone time; resume hints set PartialBytes
// and PartialEtag without filling Hash.
type FileInfo struct {
	Path    string
	Size    int64
	ModTime int64
	FileID  string `json:"-"`
	Hash    string
	// NormHash is the SHA-256 of the file's content with all \r bytes
	// stripped — set only for paths matching isTextPath, empty
	// otherwise. Lets sameContent() treat a cross-platform CRLF/LF
	// diff as not-a-modification, suppressing the upload loop when
	// a Windows editor re-saves a Mac-authored file (and vice versa).
	// On the wire it travels inside the manifest payload; old peers
	// that don't populate it fall back to byte-exact Hash comparison.
	NormHash string `json:",omitempty"`
	Version  int64
	Deleted  bool
	// PartialBytes is non-zero when the receiver side has a `.kari-incoming`
	// staging file from a previous interrupted transfer. It tells the sender
	// to skip the first PartialBytes bytes — but ONLY if PartialEtag matches
	// the sender's sha256(source[:PartialBytes]). Mismatch means the source
	// changed since the last attempt and the receiver must truncate and
	// start over.
	//
	// Zero value (default) means "no partial state, send from the start"
	// — old clients that don't know these fields ride the default.
	PartialBytes int64  `json:",omitempty"`
	PartialEtag  string `json:",omitempty"`
}

// Partial describes one half-received file's on-disk state. Built by
// scanTransTmp at engine startup; threaded into Manifest() so the
// sender knows where to resume from.
type Partial struct {
	Bytes int64  // size of the .kari-incoming staging file on disk
	Etag  string // sha256(first Bytes bytes of the staging file)
}

// Manifest serialises the engine's view of the workspace into the
// payload carried by a transport.MessageManifest envelope. Live files
// become FileInfo{Deleted:false, Hash, ModTime, Size}; tombstones
// become FileInfo{Deleted:true, Version=tombstone-time}; pure-partial
// entries set PartialBytes/PartialEtag without Hash so the peer
// knows to seek + resume. The peer runs DiffManifest against this to
// decide what to push back.
//
// Sorted by path so two peers with identical state produce
// byte-identical manifests, which simplifies debugging and lets us
// add a sha-based "have we already exchanged?" check later if needed.
func (e *Engine) Manifest() ([]byte, error) {
	snap, err := e.Snapshot()
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	tombs := make(map[string]int64, len(e.tombstones))
	for p, t := range e.tombstones {
		tombs[p] = t
	}
	parts := make(map[string]Partial, len(e.partials))
	for p, pt := range e.partials {
		parts[p] = pt
	}
	e.mu.Unlock()

	entries := make([]FileInfo, 0, len(snap)+len(tombs)+len(parts))
	paths := make([]string, 0, len(snap))
	for p := range snap {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		fi := snap[p]
		if pt, ok := parts[p]; ok {
			// A partial sitting at <target>.kari-incoming shouldn't
			// normally coexist with a complete target on disk (Commit
			// renames over it). If it does, prefer the complete
			// version and drop the partial entry.
			_ = pt
		}
		entries = append(entries, fi)
	}
	tombPaths := make([]string, 0, len(tombs))
	for p := range tombs {
		if _, alive := snap[p]; alive {
			continue
		}
		tombPaths = append(tombPaths, p)
	}
	sort.Strings(tombPaths)
	for _, p := range tombPaths {
		entries = append(entries, FileInfo{Path: p, Deleted: true, Version: tombs[p]})
	}
	// Pure-partial entries: we have a .kari-incoming for a path that
	// neither exists complete on disk nor has a tombstone. Tell the
	// peer to resume from that offset on the next push of this path.
	partialPaths := make([]string, 0, len(parts))
	for p := range parts {
		if _, alive := snap[p]; alive {
			continue
		}
		if _, dead := tombs[p]; dead {
			continue
		}
		partialPaths = append(partialPaths, p)
	}
	sort.Strings(partialPaths)
	for _, p := range partialPaths {
		entries = append(entries, FileInfo{
			Path:         p,
			PartialBytes: parts[p].Bytes,
			PartialEtag:  parts[p].Etag,
		})
	}
	return json.Marshal(entries)
}

// ParseManifest is the inverse of Manifest. Lives in package filesync so
// the session layer can decode without round-tripping through Engine —
// useful for tests and for keeping wire-format knowledge in one place.
func ParseManifest(data []byte) ([]FileInfo, error) {
	var entries []FileInfo
	if len(data) == 0 {
		return entries, nil
	}
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// DiffManifest computes what THIS engine should push to a peer given
// the peer's most recent manifest. Returns:
//   - toSendFiles: FileInfo entries for paths we should push. Each entry
//     carries the peer's PartialBytes/PartialEtag if the peer already
//     has a prefix of the file on disk — sendLoop seeks to that offset
//     and resumes instead of restarting from byte 0.
//   - toSendDeletes: tombstones this side knows about that the peer
//     hasn't applied yet (peer either has the file live with an older
//     mtime, or doesn't know about the path at all). sendLoop emits
//     MessageDelete for each.
//
// Symmetric: peer running DiffManifest against OUR manifest pushes
// back the paths we're missing. No "request" message needed.
func (e *Engine) DiffManifest(remote []FileInfo) (toSendFiles []FileInfo, toSendDeletes []FileInfo, err error) {
	local, err := e.Manifest()
	if err != nil {
		return nil, nil, err
	}
	localEntries, err := ParseManifest(local)
	if err != nil {
		return nil, nil, err
	}
	toSendFiles, toSendDeletes = DiffManifests(localEntries, remote)
	return toSendFiles, toSendDeletes, nil
}

// DiffManifests is the pure-function core of DiffManifest. Exposed for
// tests so they can seed (local, remote) directly without having to
// craft real files on disk to make Snapshot() report them.
func DiffManifests(local, remote []FileInfo) (toSendFiles []FileInfo, toSendDeletes []FileInfo) {
	remoteByPath := make(map[string]FileInfo, len(remote))
	for _, r := range remote {
		remoteByPath[r.Path] = r
	}
	localByPath := make(map[string]FileInfo, len(local))
	for _, l := range local {
		localByPath[l.Path] = l
	}

	// pushWithPartial builds a toSend entry that carries the peer's
	// resume hint (PartialBytes/PartialEtag) when present, so sendLoop
	// can stream from the matching offset instead of restarting.
	pushWithPartial := func(path string, peer FileInfo) {
		toSendFiles = append(toSendFiles, FileInfo{
			Path:         path,
			PartialBytes: peer.PartialBytes,
			PartialEtag:  peer.PartialEtag,
		})
	}

	for _, l := range local {
		r, peerHas := remoteByPath[l.Path]
		if l.Deleted {
			if !peerHas {
				continue
			}
			if r.Deleted {
				continue
			}
			if l.Version > r.ModTime {
				toSendDeletes = append(toSendDeletes, l)
			}
			continue
		}
		if !peerHas {
			toSendFiles = append(toSendFiles, FileInfo{Path: l.Path})
			continue
		}
		if r.Deleted {
			if l.ModTime > r.Version {
				toSendFiles = append(toSendFiles, FileInfo{Path: l.Path})
			}
			continue
		}
		// Peer entry is live-or-partial.
		peerIsPartialOnly := r.Hash == "" && r.PartialBytes > 0
		if peerIsPartialOnly {
			// Peer has just the staging-file prefix; we have the full
			// content. Push with the resume hint.
			pushWithPartial(l.Path, r)
			continue
		}
		if !sameContent(l, r) && l.ModTime > r.ModTime {
			pushWithPartial(l.Path, r)
		}
	}
	// Second pass: peer-only pure partials we never see in our local
	// loop because they don't exist locally yet. If we DO have the file
	// live, the first pass already handled it. If we DON'T have it,
	// nothing to push.
	_ = localByPath // currently unused; kept for symmetry / future "are we missing the file?" check
	return toSendFiles, toSendDeletes
}
