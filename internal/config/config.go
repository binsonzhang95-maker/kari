// Package config holds the small client-side helpers the single-tenant
// kari client binaries share: deriving the transport key from the shared
// secret and resolving a machine-stable client id.
//
// This is intentionally NOT the multi-tenant server config (registry DSN,
// license, per-workspace data keys, model proxy) — the single-tenant server
// configures itself from flags/env in cmd/karid. All that lives here is what
// a client needs to authenticate against the shared secret.
package config

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SharedKeyFromActivationCode derives the AES-256 transport key from the
// shared secret: base64(SHA-256(secret)). This matches the server's
// singleKeyResolver, which returns SHA-256(secret) for every workspace — so
// passing the same secret on both sides produces the same key.
func SharedKeyFromActivationCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// DecodeSharedKey decodes a base64 shared key and checks it is 32 bytes
// (AES-256). Used to turn SharedKeyFromActivationCode's output into raw key
// bytes for the transport envelope.
func DecodeSharedKey(value string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("shared_key must be base64: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("shared_key must decode to 32 bytes, got %d", len(key))
	}
	return key, nil
}

// NewClientID mints a fresh, non-persistent client id.
func NewClientID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "cli-" + base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// MachineClientID returns the machine-stable identifier used by the server's
// "one machine, one client_id" rule. Lookup order:
//  1. $KARI_CLIENT_ID — explicit override (tests, sandboxes).
//  2. <config_root>/client_id — a small file we own; the first call on a
//     fresh box writes a freshly generated id there so the CLI and the
//     desktop daemon converge on the same string with no out-of-band setup.
//  3. NewClientID() (non-persistent) — last resort if the filesystem is
//     read-only.
func MachineClientID() (string, error) {
	if v := strings.TrimSpace(os.Getenv("KARI_CLIENT_ID")); v != "" {
		return v, nil
	}
	path, err := machineClientIDPath()
	if err == nil {
		if data, readErr := os.ReadFile(path); readErr == nil {
			if id := strings.TrimSpace(string(data)); id != "" {
				return id, nil
			}
		}
	}
	id, err := NewClientID()
	if err != nil {
		return "", err
	}
	if path != "" {
		if mkErr := os.MkdirAll(filepath.Dir(path), 0o700); mkErr == nil {
			// Best-effort write; a failure just means the next invocation
			// rolls a different id, which is fine for the read-only case.
			_ = os.WriteFile(path, []byte(id+"\n"), 0o600)
		}
	}
	return id, nil
}

// MachineClientIDPath returns the path MachineClientID reads/writes, or ""
// if no sensible location could be resolved. Exposed for diagnostics.
func MachineClientIDPath() string {
	p, _ := machineClientIDPath()
	return p
}

func machineClientIDPath() (string, error) {
	if v := strings.TrimSpace(os.Getenv("KARI_HOME")); v != "" {
		return filepath.Join(v, "client_id"), nil
	}
	if v := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); v != "" {
		return filepath.Join(v, "kari", "client_id"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, ".kari", "client_id"), nil
}
