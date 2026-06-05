package filesync

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unicode/utf8"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

type docState struct {
	seq int64
}

var (
	docStateMu sync.Mutex
	docSeq     = map[string]int64{}
)

// ApplyTextOp applies a single OT-style operation onto a text file.
// This is intentionally conservative and is used for CRDT/OT-capable
// clients; binary assets should continue through file chunk transport.
func (e *Engine) ApplyTextOp(msg *transport.Message) error {
	rel := cleanRel(msg.Path)
	target := absFromRel(e.root, rel)
	if !isInside(e.root, target) {
		return fmt.Errorf("%w: %s", ErrPathEscapesRoot, msg.Path)
	}
	if e.shouldIgnore(rel, false) {
		return nil
	}

	oldBytes, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	oldText := string(oldBytes)
	if !utf8.ValidString(oldText) {
		return fmt.Errorf("text op target is not utf8: %s", rel)
	}

	newText, err := applySingleOp(oldText, msg.OpType, msg.OpPos, msg.OpLen, msg.OpText)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(target, []byte(newText), 0o644); err != nil {
		return err
	}

	info, err := statFile(e.root, rel)
	if err != nil {
		return err
	}
	docStateMu.Lock()
	nextSeq := maxInt64(docSeq[rel], msg.OpSeq) + 1
	docSeq[rel] = nextSeq
	docStateMu.Unlock()
	info.Version = nextSeq
	e.mu.Lock()
	e.index[rel] = info
	e.suppressedHash[rel] = info.Hash
	e.mu.Unlock()
	return nil
}

func applySingleOp(current, opType string, pos, length int, text string) (string, error) {
	runes := []rune(current)
	if pos < 0 || pos > len(runes) {
		return "", fmt.Errorf("text op position out of range: %d", pos)
	}
	switch opType {
	case "insert":
		left := string(runes[:pos])
		right := string(runes[pos:])
		return left + text + right, nil
	case "delete":
		if length < 0 || pos+length > len(runes) {
			return "", fmt.Errorf("text op delete range out of bounds")
		}
		left := string(runes[:pos])
		right := string(runes[pos+length:])
		return left + right, nil
	case "retain":
		return current, nil
	default:
		return "", fmt.Errorf("unsupported op_type: %s", opType)
	}
}
