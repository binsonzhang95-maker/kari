// Package syncthing is the Kari-side SPI for talking to a Syncthing
// sidecar. v1 is intentionally minimal:
//
//   - Client interface exposes only the operations the cold-safety
//     reconciler (PR1.2b) and the lease state machine (PR1.2c) need:
//     read the current config + atomically replace a single folder
//     (PutFolder) or the global options block (PutOptions). No other
//     mutation primitives.
//   - Two Client implementations: FakeClient (fake.go, in-memory,
//     used by the authority + lease modules and the PR1.2 / PR1.3a
//     test suite) and RestClient (rest_client.go, PR1.3b-1, real
//     HTTP/REST against a Syncthing sidecar's localhost-bound REST
//     port per migration §3.1 / §3.7 D3). RestClient is the
//     production path — RestClient.PutFolder / PutOptions perform
//     internal read-modify-write per migration §3.7 D7 so unknown
//     Syncthing-side fields survive Kari's mutations. FakeClient is
//     not deprecated — both implementations satisfy the same
//     contract by design.
//   - No bootstrap-mode ops (sendonly/receiveonly/sendreceive type
//     toggling) and no status-summary endpoints (GetFolderStatus /
//     GetCompletion) — those land alongside the modules that need
//     them, not preemptively here.
//
// Migration plan: docs/syncthing-migration-plan.review.zh-CN.md.
// Lease plan:     docs/syncthing-lease-plan.zh-CN.md.
package syncthing

import (
	"context"
	"errors"
	"fmt"
)

// Client is the SPI the Kari server uses to drive its managed
// Syncthing sidecar. Every implementation MUST be safe for concurrent
// use; reconciler and lease modules call into it from independent
// goroutines.
//
// Methods take context.Context so cancellation and timeouts propagate
// through the network round-trip. A nil ctx is a programming error;
// callers must pass at least context.Background().
type Client interface {
	// GetConfig returns the current Syncthing config view (folders +
	// global options) that Kari cares about. The returned value is a
	// snapshot; mutations to the result do not affect the sidecar.
	GetConfig(ctx context.Context) (*Config, error)

	// PutFolder atomically replaces (or creates) a single folder's
	// configuration. The Syncthing REST endpoint behind this is
	//   PUT /rest/config/folders/<id>
	// which accepts the full Folder object in one transactional write.
	//
	// This is the only folder-mutation primitive PR1.2b and PR1.2c
	// use; in particular, the "pause folder + remove client device"
	// fail-closed action is a single PutFolder call (not pause then
	// remove) so the two state changes can't be observed mid-flight
	// by a peer over BEP. See migration §4.5 step 5 + §4.4.
	//
	// Implementations MUST reject invalid Folder values (see
	// Folder.Validate) before touching state; the fake matches the
	// real REST's rejection behaviour so authority tests fail fast on
	// malformed desired state.
	PutFolder(ctx context.Context, folder Folder) error

	// PutOptions atomically replaces the global Syncthing options the
	// reconciler enforces (LocalAnnounceEnabled / GlobalAnnounceEnabled
	// / RelaysEnabled / NATEnabled — see ConfigOptions). The Syncthing
	// REST endpoint behind this is
	//   PUT /rest/config/options
	// PR1.2b reconciler uses it on every drift-recovery cycle and on
	// cold-safety to pin the options back to the fail-closed-safe set
	// (all four = false). See migration §4.5 step 4.
	PutOptions(ctx context.Context, opts ConfigOptions) error
}

// Folder type values. The Syncthing REST API accepts the three
// strings below; PR1 does not need additional types (metadata-only,
// receiveencrypted, etc).
const (
	FolderTypeSendOnly    = "sendonly"
	FolderTypeReceiveOnly = "receiveonly"
	FolderTypeSendReceive = "sendreceive"
)

// Folder is the subset of a Syncthing folder configuration that Kari's
// reconciler / lease modules read and write. Fields not in this struct
// (versioning policy, ignore patterns, fsWatcher tuning, …) will be
// added as later PRs need them; we deliberately don't pre-declare
// fields just to mirror the wire schema.
type Folder struct {
	// JSON tags use Syncthing's wire field names (see §3.7 D7
	// Kari-owned key list) so RestClient (PR1.3b-1) can directly
	// marshal/unmarshal against /rest/config/folders/<id> bodies.
	// Tag values match Syncthing v1.27 REST schema exactly — if
	// Syncthing renames a field upstream, version assert at
	// startup catches it before any data movement begins.

	// ID is the Kari-derived folder_id (migration §2.1 formula
	// "kari1_" + slug(workspace_id) + "__" + shortsha256(workspace_id)).
	// Stable across renames; immutable across the workspace's lifetime
	// while the Syncthing backend is enabled.
	ID string `json:"id"`

	// Path is the absolute filesystem path Syncthing watches /
	// rescans. Server side: <sync_root>/<workspace_id>/<workspace_name>.
	// Client side: the user's workspace root.
	Path string `json:"path"`

	// Type is one of "sendonly" / "receiveonly" / "sendreceive". v1
	// does not model the per-folder "metadata-only" type. Bootstrap
	// state machine (migration §4.2) drives transitions between
	// directional and sendreceive.
	Type string `json:"type"`

	// Paused mirrors the Syncthing-side `paused` flag. True means
	// Syncthing does not exchange index / data for this folder; the
	// reconciler keeps it true whenever any desired-state gate
	// (lease / bootstrap / quarantine / manual / migration lock)
	// demands it (migration §4.5).
	Paused bool `json:"paused"`

	// Devices lists the device IDs Kari has authorised to share this
	// folder. Cardinality rules are role-specific (migration §4.5
	// invariant + §2.5 bootstrap):
	//
	//   * Server-side, steady state: exactly {server_self,
	//     current_client_device}.
	//   * Server-side, no-client / fail-closed cleanup: {server_self}.
	//     Server NEVER drops itself; "pause + remove device" removes
	//     only the client device.
	//   * Client-side, pre-bootstrap (before folder_ready /
	//     mode_b_ready): exactly {client_self}. May NOT include the
	//     server device until role arbitration completes
	//     (migration §4.2 invariants).
	//   * Client-side, steady state: {client_self, server_device}.
	//
	// Folder.Validate enforces the device-id-nonempty + uniqueness
	// invariants; whichever role-specific membership rule applies is
	// the caller's (reconciler / bootstrap state machine) job.
	Devices []Device `json:"devices"`

	// Label is the human-readable folder name surfaced in Syncthing's
	// UI / status output. Kari-owned per migration §3.7 D7
	// (Kari-owned-field list) — set at bootstrap from workspace_name,
	// preserved across cleanup mutations (see Reconciler.MarkDesiredCleanup).
	// Empty string is valid (Syncthing falls back to ID in its UI).
	Label string `json:"label"`
}

// Validate checks the structural invariants every Folder must hold
// before being passed to a Client. Returns the first failure
// encountered.
//
// The contract is intentionally tight at the SPI layer:
//   - Role-specific membership (server_self always present on the
//     server side, etc) is NOT enforced here — it depends on which
//     role is calling and what bootstrap stage we're in. That logic
//     lives in the reconciler / bootstrap state machine.
//   - Field semantics (Path absolute, ID matches the kari1_ formula)
//     are also caller's responsibility; this method only catches
//     wire-shape errors that the real Syncthing REST would reject.
func (f Folder) Validate() error {
	if f.ID == "" {
		return errors.New("syncthing: Folder.ID is required")
	}
	switch f.Type {
	case "", FolderTypeSendOnly, FolderTypeReceiveOnly, FolderTypeSendReceive:
		// Empty Type is accepted at the SPI layer because v1's
		// bootstrap flow may construct Folder values incrementally
		// (e.g. pause+remove fail-closed cleanup, where the original
		// Type doesn't matter). Reconciler enforces Type matches its
		// expectation at the desired-state level.
	default:
		return errors.New("syncthing: Folder.Type must be one of {sendonly, receiveonly, sendreceive} or empty")
	}
	seen := make(map[string]struct{}, len(f.Devices))
	for i, d := range f.Devices {
		if d.DeviceID == "" {
			return fmt.Errorf("syncthing: Folder.Devices[%d].DeviceID is empty", i)
		}
		if _, dup := seen[d.DeviceID]; dup {
			return fmt.Errorf("syncthing: Folder.Devices contains duplicate DeviceID %q", d.DeviceID)
		}
		seen[d.DeviceID] = struct{}{}
	}
	return nil
}

// Device identifies one peer that may participate in a folder. Kari
// only cares about the device certificate fingerprint; the friendly
// Name is preserved for diagnostics / logs.
type Device struct {
	// DeviceID is the Syncthing device certificate fingerprint
	// (52-char base32). The same identity Syncthing exchanges over
	// BEP TLS to authenticate the peer.
	DeviceID string `json:"deviceID"`

	// Name is a human-readable label. Empty is fine.
	Name string `json:"name,omitempty"`
}

// Config is the snapshot view GetConfig returns. v1 includes folders
// + the global options the reconciler enforces to fail-closed
// (migration §4.5 step 4). Per-device introducer / auto-accept flags
// will be exposed on Device when bootstrap needs them.
type Config struct {
	Folders []Folder      `json:"folders"`
	Devices []Device      `json:"devices"`
	Options ConfigOptions `json:"options"`
}

// ConfigOptions mirrors the global Syncthing options Kari pins to
// "off" during cold-safety + every reconciler tick. Anything not
// listed here is treated as Kari-doesn't-care; the reconciler does
// not assert their values.
type ConfigOptions struct {
	// LocalAnnounceEnabled — broadcast on local network. v1: false.
	LocalAnnounceEnabled bool `json:"localAnnounceEnabled"`

	// GlobalAnnounceEnabled — talk to Syncthing's global discovery
	// servers. v1: false. We don't want a leaked client device to
	// be discoverable to anyone outside the Kari membership.
	GlobalAnnounceEnabled bool `json:"globalAnnounceEnabled"`

	// RelaysEnabled — use Syncthing's relay pool. v1: false. We
	// require direct dial to the server's explicit data port
	// (migration §6).
	RelaysEnabled bool `json:"relaysEnabled"`

	// NATEnabled — use STUN / UPnP for NAT traversal. v1: false
	// (migration §4.5 step 4). Client always dials server, server is
	// expected to be on a reachable address.
	NATEnabled bool `json:"natEnabled"`
}
