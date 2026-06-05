package filesync

import (
	"os"
	"path/filepath"
	"strings"
)

// IgnoreFile is the .gitignore at the root of every workspace.
// Lines follow gitignore-style semantics. Synced as a normal file.
const IgnoreFile = ".gitignore"

// KariIgnoreFile is the Kari-specific ignore file at the workspace
// root. Same gitignore syntax. The daemon writes a conservative
// default on first download (deps / caches / build artifacts) so
// large project mirrors don't pull in node_modules / .vite / dist
// by default. User-editable: live at the workspace root next to
// .gitignore, visible in the file tree, syncs across peers. Never
// overwritten by the daemon once it exists — user edits stick.
//
// Combined with .gitignore via LoadCombinedIgnoreMatcher: a path is
// ignored if EITHER file matches (with negations in either file
// taking effect normally inside that file). Listed second so its
// patterns evaluate after .gitignore's — negations in .kariignore
// can re-include a .gitignore'd path.
const KariIgnoreFile = ".kariignore"

// IgnoreMatcher decides whether a sync-relative path should be skipped on
// scan / send / apply. A nil receiver matches nothing, which means the
// caller may treat "no .gitignore present" identically to "every entry
// is allowed".
type IgnoreMatcher struct {
	patterns []ignorePattern
}

type ignorePattern struct {
	pattern  string // glob, with leading slash and trailing slash stripped
	negate   bool   // starts with `!`
	dirOnly  bool   // ends with `/`
	anchored bool   // pattern contains a `/` (matches against the full rel path, not basename)
}

// LoadIgnoreFile reads `<root>/.gitignore`. Returns an empty matcher if
// the file is missing.
func LoadIgnoreFile(root string) (*IgnoreMatcher, error) {
	return loadIgnoreFileByName(root, IgnoreFile)
}

// LoadKariIgnoreFile reads `<root>/.kariignore`. Returns an empty
// matcher if the file is missing. Used alongside LoadIgnoreFile via
// LoadCombinedIgnoreMatcher.
func LoadKariIgnoreFile(root string) (*IgnoreMatcher, error) {
	return loadIgnoreFileByName(root, KariIgnoreFile)
}

func loadIgnoreFileByName(root, name string) (*IgnoreMatcher, error) {
	path := filepath.Join(root, name)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &IgnoreMatcher{}, nil
		}
		return nil, err
	}
	return ParseIgnore(string(data)), nil
}

// LoadCombinedIgnoreMatcher loads both .gitignore and .kariignore
// from the workspace root and returns a matcher that ignores a path
// when EITHER file's effective rules match. The patterns are
// concatenated in (gitignore, kariignore) order so a negation in
// .kariignore can re-include a path that .gitignore would have
// matched (negations are evaluated after the most recent positive
// hit per Match's last-write-wins semantic). Either missing file is
// treated as empty.
func LoadCombinedIgnoreMatcher(root string) (*IgnoreMatcher, error) {
	git, err := LoadIgnoreFile(root)
	if err != nil {
		return nil, err
	}
	kari, err := LoadKariIgnoreFile(root)
	if err != nil {
		return nil, err
	}
	if git == nil && kari == nil {
		return &IgnoreMatcher{}, nil
	}
	merged := &IgnoreMatcher{}
	if git != nil {
		merged.patterns = append(merged.patterns, git.patterns...)
	}
	if kari != nil {
		merged.patterns = append(merged.patterns, kari.patterns...)
	}
	return merged, nil
}

// ParseIgnore parses .gitignore content. Empty lines and lines starting
// with `#` are skipped. Patterns starting with `!` are negations (re-include
// previously excluded paths). Trailing `/` means directory-only.
func ParseIgnore(content string) *IgnoreMatcher {
	var ps []ignorePattern
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var p ignorePattern
		if strings.HasPrefix(line, "!") {
			p.negate = true
			line = line[1:]
		}
		if strings.HasSuffix(line, "/") {
			p.dirOnly = true
			line = strings.TrimSuffix(line, "/")
		}
		// Strip a leading `/` — anchored to the workspace root either way.
		line = strings.TrimPrefix(line, "/")
		p.anchored = strings.Contains(line, "/")
		p.pattern = line
		if p.pattern != "" {
			ps = append(ps, p)
		}
	}
	return &IgnoreMatcher{patterns: ps}
}

// Match reports whether `rel` (forward-slash separated, sync-root relative)
// should be skipped. `isDir` controls whether dir-only patterns can match
// `rel` itself; dir-only patterns *always* match files / directories that
// live underneath an ignored directory (e.g. `build/` blocks both the
// `build` directory and `build/output.txt`).
func (m *IgnoreMatcher) Match(rel string, isDir bool) bool {
	if m == nil || len(m.patterns) == 0 {
		return false
	}
	rel = strings.TrimPrefix(filepath.ToSlash(rel), "/")
	if rel == "" {
		return false
	}

	// Build the ancestor list (e.g. "a/b/c.txt" -> ["a", "a/b"]) so
	// dir-only patterns can punt anything below them.
	var ancestors []string
	if idx := strings.LastIndex(rel, "/"); idx > 0 {
		acc := ""
		for _, seg := range strings.Split(rel[:idx], "/") {
			if acc == "" {
				acc = seg
			} else {
				acc = acc + "/" + seg
			}
			ancestors = append(ancestors, acc)
		}
	}

	matched := false
	for _, p := range m.patterns {
		hit := false
		if p.dirOnly {
			if isDir && p.matches(rel) {
				hit = true
			}
			if !hit {
				for _, anc := range ancestors {
					if p.matches(anc) {
						hit = true
						break
					}
				}
			}
		} else if p.matches(rel) {
			hit = true
		}
		if hit {
			matched = !p.negate
		}
	}
	return matched
}

// matches checks whether the given relative path matches this pattern.
// Anchored patterns (with `/`) match the full path; unanchored patterns
// match any single path component along the way (so `node_modules`
// blocks both `./node_modules` and `pkg/sub/node_modules`).
func (p ignorePattern) matches(rel string) bool {
	if p.anchored {
		ok, err := filepath.Match(p.pattern, rel)
		if err == nil && ok {
			return true
		}
		// Also match if the pattern matches a prefix path that contains
		// `rel` — handles "build/*" matching "build/anything".
		if strings.HasPrefix(rel, strings.TrimSuffix(p.pattern, "/*")+"/") {
			return true
		}
		return false
	}
	for _, segment := range strings.Split(rel, "/") {
		if ok, err := filepath.Match(p.pattern, segment); err == nil && ok {
			return true
		}
	}
	return false
}
