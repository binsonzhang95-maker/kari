package filesync

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// textExts is the set of file extensions we treat as "text" for the
// purpose of EOL-normalised hashing. The extension whitelist is
// intentionally conservative: cross-platform sync mirrors bytes exactly
// for everything not on this list, so a binary file mistakenly added
// here would be silently corrupted on the round-trip if we ever moved
// to autocrlf-style on-disk conversion. We only use the norm hash to
// suppress "modified" detection — the bytes on the wire are still
// byte-exact — so a false positive (extension claimed text but actually
// binary) merely loses the suppression benefit, it does not corrupt.
var textExts = map[string]struct{}{
	".bash":          {},
	".bat":           {},
	".c":             {},
	".cc":            {},
	".cfg":           {},
	".clj":           {},
	".cmd":           {},
	".coffee":        {},
	".conf":          {},
	".cpp":           {},
	".cs":            {},
	".css":           {},
	".csv":           {},
	".cxx":           {},
	".dart":          {},
	".dockerignore":  {},
	".editorconfig":  {},
	".elm":           {},
	".env":           {},
	".erl":           {},
	".ex":            {},
	".exs":           {},
	".fish":          {},
	".fs":            {},
	".gemspec":       {},
	".gitattributes": {},
	".gitignore":     {},
	".go":            {},
	".gradle":        {},
	".graphql":       {},
	".groovy":        {},
	".h":             {},
	".hbs":           {},
	".hpp":           {},
	".hs":            {},
	".htm":           {},
	".html":          {},
	".hxx":           {},
	".ini":           {},
	".java":          {},
	".jl":            {},
	".js":            {},
	".json":          {},
	".jsx":           {},
	".kt":            {},
	".kts":           {},
	".less":          {},
	".lock":          {},
	".log":           {},
	".lua":           {},
	".m":             {},
	".md":            {},
	".mdx":           {},
	".mjs":           {},
	".mk":            {},
	".mm":            {},
	".php":           {},
	".pl":            {},
	".plist":         {},
	".pm":            {},
	".properties":    {},
	".proto":         {},
	".ps1":           {},
	".py":            {},
	".r":             {},
	".rb":            {},
	".rs":            {},
	".rst":           {},
	".s":             {},
	".scala":         {},
	".scss":          {},
	".sh":            {},
	".sql":           {},
	".styl":          {},
	".svelte":        {},
	".svg":           {},
	".swift":         {},
	".tcl":           {},
	".text":          {},
	".tf":            {},
	".toml":          {},
	".ts":            {},
	".tsv":           {},
	".tsx":           {},
	".txt":           {},
	".vb":            {},
	".vue":           {},
	".xml":           {},
	".yaml":          {},
	".yml":           {},
	".zsh":           {},
}

// textBasenames covers a few common extension-less files that are
// always text by convention.
var textBasenames = map[string]struct{}{
	"Dockerfile": {},
	"Makefile":   {},
	"Rakefile":   {},
	"Gemfile":    {},
	"Procfile":   {},
	"LICENSE":    {},
	"README":     {},
	"CHANGELOG":  {},
	"AUTHORS":    {},
	"CONTRIBUTORS": {},
}

// isTextPath decides whether a file should receive an EOL-normalised
// hash. The decision is by extension (or known basename) only — we do
// not sniff content.
func isTextPath(rel string) bool {
	base := filepath.Base(rel)
	if _, ok := textBasenames[base]; ok {
		return true
	}
	ext := strings.ToLower(filepath.Ext(base))
	if ext == "" {
		return false
	}
	_, ok := textExts[ext]
	return ok
}

// sameContent reports whether two FileInfos describe the same logical
// content. Bytes match → trivially yes. Bytes differ but both sides
// computed an EOL-normalised hash and those match → also yes (the
// difference is line-ending only, e.g. a Windows editor re-saved a
// Mac-authored file as CRLF). Used by manifest diffing, pre-send
// dedup, and rescan change detection to suppress the cross-platform
// CRLF/LF "everything looks modified" false positive.
func sameContent(a, b FileInfo) bool {
	if a.Hash != "" && a.Hash == b.Hash {
		return true
	}
	if a.NormHash != "" && a.NormHash == b.NormHash {
		return true
	}
	return false
}

// computeFileHashes returns the raw byte SHA-256 of the file at path,
// the EOL-normalised SHA-256 (only if isTextPath(rel) is true; empty
// otherwise), and the total byte count. Single I/O pass.
//
// EOL normalisation: \r bytes are stripped before hashing. This
// collapses CRLF → LF and bare CR → "" — both common artefacts of
// editors auto-converting line endings on save. The choice to strip
// rather than replace keeps the implementation a one-byte filter and
// matches what `dos2unix` does to text files.
func computeFileHashes(path, rel string) (rawHash, normHash string, size int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", 0, err
	}
	defer f.Close()

	wantNorm := isTextPath(rel)
	raw := sha256.New()
	norm := sha256.New()
	buf := make([]byte, 32*1024)
	stripped := make([]byte, 32*1024)

	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			raw.Write(buf[:n])
			size += int64(n)
			if wantNorm {
				w := stripped[:0]
				for _, b := range buf[:n] {
					if b != '\r' {
						w = append(w, b)
					}
				}
				norm.Write(w)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", "", 0, rerr
		}
	}

	rawHash = hex.EncodeToString(raw.Sum(nil))
	if wantNorm {
		normHash = hex.EncodeToString(norm.Sum(nil))
	}
	return rawHash, normHash, size, nil
}
