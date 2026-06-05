package syncthing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// RestClient is the production Client implementation that talks to
// a Syncthing sidecar's REST API. Implements syncthing.Client; safe
// for concurrent use (the underlying *http.Client is).
//
// PR1.3b-1 scope: RestClient ONLY. This file does NOT spawn or
// supervise the sidecar process (that's PR1.3b-2), does NOT wire
// into main() or any readiness gate (PR1.3b-4), and does NOT run
// cold-safety / startup-rebuild (PR1.3b-3). It's a pure HTTP-against-
// Syncthing-REST primitive that subsequent PRs compose.
//
// Read-modify-write contract per migration plan §3.7 D7:
//   - PutFolder internally does GET → merge → PUT, preserving ALL
//     unknown fields on the server-side folder (rescanIntervalS,
//     versioning, etc.) and inside each device entry (introducer,
//     encryptionPassword, ...). Kari only overwrites the documented
//     Kari-owned keys: paused / devices / path / type / label.
//   - PutOptions does the same for the global config options object,
//     overwriting only LocalAnnounceEnabled / GlobalAnnounceEnabled
//     / RelaysEnabled / NATEnabled.
//   - Empty string values for Path / Type / Label are TREATED AS
//     "don't overlay" — this is the round-2 review gotcha pinned in
//     project_desired_folder_type_overlay_gotcha memory. Caller
//     wanting to clear a value must use a different API (none today).
//
// All requests carry X-API-Key. 4xx / 5xx responses return *RestError
// so callers can detect Status==404 via errors.As + RestError.IsNotFound.
type RestClient struct {
	baseURL string
	apiKey  string
	httpc   *http.Client
}

// NewRestClient constructs a RestClient pointing at baseURL with
// apiKey. baseURL should be the Syncthing GUI/REST origin without
// trailing slash, e.g. "http://127.0.0.1:18384" (matches §3.7 D3
// loopback-only bind). apiKey is the ephemeral STGUIAPIKEY value
// the sidecar was launched with.
//
// httpc default: 10s timeout per request. Tests can override via
// SetHTTPClient (e.g. httptest with hung-connection scenarios);
// production should rely on the constructor default.
func NewRestClient(baseURL, apiKey string) *RestClient {
	return &RestClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		httpc:   &http.Client{Timeout: 10 * time.Second},
	}
}

// SetHTTPClient overrides the default *http.Client used for requests.
// Test-only — production uses NewRestClient's default. Don't expose
// on PR1.3b production paths; passing a hand-tuned client implies
// the caller has REST-shaped assumptions that should live here.
func (c *RestClient) SetHTTPClient(client *http.Client) {
	if client != nil {
		c.httpc = client
	}
}

// Compile-time assertion that RestClient satisfies the Client
// interface. Renaming a Client method without updating RestClient
// fails the build here, before any consumer can drift.
var _ Client = (*RestClient)(nil)

// RestError is a typed REST failure returned by RestClient methods
// on any 4xx / 5xx response. Carries the HTTP status + the response
// body + the request method/path for diagnostic logging.
//
// Detect 404 specifically via IsNotFound (used by PutFolder to
// distinguish "folder doesn't exist yet, start from minimal map"
// from real errors).
type RestError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *RestError) Error() string {
	// Truncate body in the formatted message — full body is still
	// in the .Body field for inspection.
	body := e.Body
	if len(body) > 200 {
		body = body[:200] + "...(truncated)"
	}
	return fmt.Sprintf("syncthing rest: %s %s status=%d body=%s", e.Method, e.Path, e.Status, body)
}

// IsNotFound reports whether this is a 404 response. Used by
// PutFolder to handle the "folder doesn't exist yet, create from
// scratch" path without conflating with other 4xx errors.
func (e *RestError) IsNotFound() bool {
	return e.Status == http.StatusNotFound
}

// do is the single REST roundtrip primitive. body may be nil
// (GET / DELETE) or any json.Marshal'able value (PUT / POST).
// Returns the raw response body up to a 32MB cap; larger responses
// are an error.
func (c *RestClient) do(ctx context.Context, method, path string, body any) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("syncthing rest: marshal %s %s body: %w", method, path, err)
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("syncthing rest: build request: %w", err)
	}
	req.Header.Set("X-API-Key", c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("syncthing rest: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	// Cap at 32MB. Read 32MB+1 byte so we can DETECT exceedance —
	// io.LimitReader silently truncates, which would let an
	// over-sized response sneak through as a successful read. If
	// length > cap, treat it as an error (no Syncthing REST endpoint
	// Kari uses returns anywhere near 32MB; this is purely a
	// safety bound against a malformed / hostile sidecar).
	const maxBody = 32 << 20
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("syncthing rest: read %s %s body: %w", method, path, err)
	}
	if len(respBody) > maxBody {
		return nil, fmt.Errorf("syncthing rest: %s %s response body too large (>%d bytes); refused", method, path, maxBody)
	}
	if resp.StatusCode >= 400 {
		return nil, &RestError{
			Method: method,
			Path:   path,
			Status: resp.StatusCode,
			Body:   string(respBody),
		}
	}
	return respBody, nil
}

// GetConfig fetches the full /rest/config and decodes into Kari's
// typed Config. Unknown JSON fields are dropped (json's default
// behaviour) — RestClient holds no per-call cache of raw config;
// the raw view is only kept transiently inside PutFolder /
// PutOptions during their internal merge round-trip.
func (c *RestClient) GetConfig(ctx context.Context) (*Config, error) {
	body, err := c.do(ctx, http.MethodGet, "/rest/config", nil)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		return nil, fmt.Errorf("syncthing rest: GetConfig unmarshal: %w (body=%s)", err, truncate(string(body), 200))
	}
	return &cfg, nil
}

// PutFolder implements the D7 RMW contract. Sequence:
//
//	(a) GET /rest/config/folders/<id>  → raw JSON
//	    404 → start from empty map (new folder; syncthing fills its
//	          own defaults on PUT). Other 4xx/5xx → propagate.
//	(b) Parse raw into map[string]json.RawMessage so EVERY field
//	    (known and unknown) survives the round-trip.
//	(c) Overlay Kari-owned keys: id / paused / devices / path /
//	    type / label. Empty Path / Type / Label SKIP overlay
//	    (preserves whatever was there server-side) — see
//	    project_desired_folder_type_overlay_gotcha. Devices is
//	    ALWAYS overlay'd as whole-replace; nil or empty Devices
//	    writes `[]` (Kari owns the device set per §4.5). Each
//	    RETAINED device's unknown sub-fields are preserved via
//	    per-device RMW (introducer / encryptionPassword / ...);
//	    dropped devices stay dropped.
//	(d) PUT merged map.
func (c *RestClient) PutFolder(ctx context.Context, folder Folder) error {
	if err := folder.Validate(); err != nil {
		return err
	}
	path := "/rest/config/folders/" + folder.ID
	var raw map[string]json.RawMessage
	respBody, err := c.do(ctx, http.MethodGet, path, nil)
	switch {
	case err == nil:
		if uerr := json.Unmarshal(respBody, &raw); uerr != nil {
			return fmt.Errorf("syncthing rest: PutFolder GET-side unmarshal: %w (body=%s)", uerr, truncate(string(respBody), 200))
		}
	default:
		var rerr *RestError
		if errors.As(err, &rerr) && rerr.IsNotFound() {
			// New folder — start from minimal map; syncthing fills
			// defaults on PUT. Kari explicitly does not seed any
			// rescanIntervalS / versioning / etc. defaults itself.
			raw = map[string]json.RawMessage{}
		} else {
			return err
		}
	}
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	if err := overlayKariOwnedFolderFields(raw, folder); err != nil {
		return fmt.Errorf("syncthing rest: PutFolder overlay: %w", err)
	}
	if _, err := c.do(ctx, http.MethodPut, path, raw); err != nil {
		return err
	}
	return nil
}

// PutDevice registers (or updates) a device in the top-level Syncthing
// device list via PUT /rest/config/devices/{id}. Required before a
// device can appear in any folder's devices array — Syncthing
// silently drops folder.devices entries whose deviceID isn't in the
// top-level device list.
//
// Pair-info (syncthing migration Phase 1.2(b)) calls this with the
// desktop's device id so the server's Reconciler.SetDesired folder
// device list takes effect on the next reconcile tick. Idempotent —
// Syncthing accepts repeated PUTs.
//
// Not part of the Client interface (the reconciler doesn't manage
// device lifecycle; that's pair-info's job). Public so cmd/server's
// pair-info handler can call it directly.
func (c *RestClient) PutDevice(ctx context.Context, deviceID, name string, addresses []string) error {
	if deviceID == "" {
		return fmt.Errorf("syncthing rest: PutDevice requires non-empty deviceID")
	}
	if len(addresses) == 0 {
		addresses = []string{"dynamic"}
	}
	path := "/rest/config/devices/" + deviceID
	// RMW: GET existing entry (404 -> create), overlay our owned
	// fields, PUT back. Matches PutFolder's preserve-unknown pattern.
	var raw map[string]json.RawMessage
	respBody, err := c.do(ctx, http.MethodGet, path, nil)
	switch {
	case err == nil:
		if uerr := json.Unmarshal(respBody, &raw); uerr != nil {
			return fmt.Errorf("syncthing rest: PutDevice GET-side unmarshal: %w (body=%s)", uerr, truncate(string(respBody), 200))
		}
	default:
		var rerr *RestError
		if errors.As(err, &rerr) && rerr.IsNotFound() {
			raw = map[string]json.RawMessage{}
		} else {
			return err
		}
	}
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	if err := setJSONString(raw, "deviceID", deviceID); err != nil {
		return fmt.Errorf("syncthing rest: PutDevice overlay deviceID: %w", err)
	}
	if err := setJSONString(raw, "name", name); err != nil {
		return fmt.Errorf("syncthing rest: PutDevice overlay name: %w", err)
	}
	addrBytes, merr := json.Marshal(addresses)
	if merr != nil {
		return fmt.Errorf("syncthing rest: PutDevice marshal addresses: %w", merr)
	}
	raw["addresses"] = addrBytes
	if _, err := c.do(ctx, http.MethodPut, path, raw); err != nil {
		return err
	}
	return nil
}

// PutOptions implements RMW for the global config options. Same
// pattern as PutFolder: GET /rest/config/options → merge Kari-owned
// keys → PUT. Unknown options (the dozens of fields Kari doesn't
// model) are preserved exactly as the server had them.
func (c *RestClient) PutOptions(ctx context.Context, options ConfigOptions) error {
	const path = "/rest/config/options"
	respBody, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(respBody, &raw); err != nil {
		return fmt.Errorf("syncthing rest: PutOptions GET-side unmarshal: %w (body=%s)", err, truncate(string(respBody), 200))
	}
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	if err := overlayKariOwnedOptionsFields(raw, options); err != nil {
		return fmt.Errorf("syncthing rest: PutOptions overlay: %w", err)
	}
	if _, err := c.do(ctx, http.MethodPut, path, raw); err != nil {
		return err
	}
	return nil
}

// SystemStatusResult is the projection of /rest/system/status that
// callers actually need today. The endpoint returns ~30 fields
// (goroutines, alloc, sys, cpuPercent, ...) but PR1.3b-3 only
// needs MyID for the server-self device identity per §3.7 D4 step 5.
// Add fields here as new callers need them; unknown JSON keys
// continue to be dropped.
type SystemStatusResult struct {
	MyID string `json:"myID"`
}

// SystemStatus fetches /rest/system/status. Used by PR1.3b-3's
// cold-safety pass to capture the sidecar's own device ID into
// the server struct (so MarkDesiredCleanup gets a non-empty
// serverSelfDevice — see project_syncthing_server_device_invariant).
//
// Not part of the Client interface — pure RestClient method. The
// interface only models config CRUD; system-status is a separate
// concern.
func (c *RestClient) SystemStatus(ctx context.Context) (*SystemStatusResult, error) {
	body, err := c.do(ctx, http.MethodGet, "/rest/system/status", nil)
	if err != nil {
		return nil, err
	}
	var s SystemStatusResult
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, fmt.Errorf("syncthing rest: SystemStatus unmarshal: %w (body=%s)", err, truncate(string(body), 200))
	}
	return &s, nil
}

// SystemConnections fetches /rest/system/connections and returns a map of
// remote device ID → connected. Used for client presence: a workspace whose
// folder is shared with a currently-connected remote (desktop) device has a
// live client even when no gRPC PTY/sync session is open (file sync runs over
// Syncthing's BEP, not a gRPC session). Like SystemStatus, this is a pure
// RestClient method — not part of the Client interface (which models only
// config CRUD).
func (c *RestClient) SystemConnections(ctx context.Context) (map[string]bool, error) {
	body, err := c.do(ctx, http.MethodGet, "/rest/system/connections", nil)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Connections map[string]struct {
			Connected bool `json:"connected"`
		} `json:"connections"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("syncthing rest: SystemConnections unmarshal: %w (body=%s)", err, truncate(string(body), 200))
	}
	out := make(map[string]bool, len(parsed.Connections))
	for id, conn := range parsed.Connections {
		out[id] = conn.Connected
	}
	return out, nil
}

// overlayKariOwnedFolderFields writes the Kari-owned subset of
// `folder` into the merge map `raw`. Empty Path / Type / Label
// fields are SKIPPED (do not overlay the existing server-side
// value). Devices is ALWAYS overlay'd as whole-replace (nil or
// empty Devices → JSON `[]`); RETAINED devices preserve their
// unknown sub-fields via per-device RMW, dropped devices stay
// dropped. Mutates raw in place.
func overlayKariOwnedFolderFields(raw map[string]json.RawMessage, folder Folder) error {
	// id — always overlay; PR1.3b-1 PutFolder always knows its own ID.
	if err := setJSONString(raw, "id", folder.ID); err != nil {
		return err
	}
	// paused — bool has no "empty" tri-state; always overlay.
	if err := setJSONBool(raw, "paused", folder.Paused); err != nil {
		return err
	}
	// path / type / label — overlay only when non-empty. Empty
	// string means "Kari isn't asserting this field; leave server's
	// value alone". The type-overlay gotcha is the canonical scenario.
	if folder.Path != "" {
		if err := setJSONString(raw, "path", folder.Path); err != nil {
			return err
		}
	}
	if folder.Type != "" {
		if err := setJSONString(raw, "type", folder.Type); err != nil {
			return err
		}
	}
	if folder.Label != "" {
		if err := setJSONString(raw, "label", folder.Label); err != nil {
			return err
		}
	}
	// devices — ALWAYS overlay. Kari owns the device set per
	// migration §4.5; nil and empty slice both mean "no devices".
	// Round-1 review Blocking fix: preserving server-side devices
	// when caller passed nil diverged from FakeClient (which is
	// whole-replace), so PR1.2 tests against FakeClient would mask
	// a production silent-preserve bug. Unified behaviour: caller
	// supplies the complete desired device set every time;
	// per-device RMW (mergeDeviceArray) only preserves each RETAINED
	// device's unknown sub-fields (introducer / encryptionPassword /
	// introducedBy / etc.), it does NOT preserve dropped devices.
	merged, err := mergeDeviceArray(raw["devices"], folder.Devices)
	if err != nil {
		return fmt.Errorf("merge devices: %w", err)
	}
	b, err := json.Marshal(merged)
	if err != nil {
		return fmt.Errorf("marshal merged devices: %w", err)
	}
	raw["devices"] = json.RawMessage(b)
	return nil
}

// overlayKariOwnedOptionsFields writes Kari's 4 pinned options into
// the merge map. Bool fields are always overlay'd (no tri-state).
func overlayKariOwnedOptionsFields(raw map[string]json.RawMessage, opts ConfigOptions) error {
	if err := setJSONBool(raw, "localAnnounceEnabled", opts.LocalAnnounceEnabled); err != nil {
		return err
	}
	if err := setJSONBool(raw, "globalAnnounceEnabled", opts.GlobalAnnounceEnabled); err != nil {
		return err
	}
	if err := setJSONBool(raw, "relaysEnabled", opts.RelaysEnabled); err != nil {
		return err
	}
	if err := setJSONBool(raw, "natEnabled", opts.NATEnabled); err != nil {
		return err
	}
	return nil
}

// mergeDeviceArray builds the new devices array by matching each
// Kari Device against existing raw entries on deviceID; matched
// entries preserve all their unknown fields (introducer,
// encryptionPassword, etc.). Unmatched Kari devices start from a
// minimal {"deviceID": X[, "name": Y]} map. Existing entries with
// no matching Kari device are DROPPED — Kari owns the device set
// (migration §4.5 invariant).
func mergeDeviceArray(existingRaw json.RawMessage, kariDevices []Device) ([]map[string]json.RawMessage, error) {
	byID := map[string]map[string]json.RawMessage{}
	if len(existingRaw) > 0 {
		var arr []map[string]json.RawMessage
		if err := json.Unmarshal(existingRaw, &arr); err != nil {
			return nil, fmt.Errorf("unmarshal existing devices: %w", err)
		}
		for _, m := range arr {
			didRaw, ok := m["deviceID"]
			if !ok {
				continue
			}
			var did string
			if err := json.Unmarshal(didRaw, &did); err != nil {
				continue
			}
			byID[did] = m
		}
	}
	out := make([]map[string]json.RawMessage, 0, len(kariDevices))
	for _, d := range kariDevices {
		m := byID[d.DeviceID]
		if m == nil {
			m = map[string]json.RawMessage{}
		}
		if err := setJSONString(m, "deviceID", d.DeviceID); err != nil {
			return nil, err
		}
		if d.Name != "" {
			if err := setJSONString(m, "name", d.Name); err != nil {
				return nil, err
			}
		}
		out = append(out, m)
	}
	return out, nil
}

// setJSONString marshals s and writes it into raw[key]. Trivial
// helper; surfaces marshal errors with the key in context.
func setJSONString(raw map[string]json.RawMessage, key, s string) error {
	b, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", key, err)
	}
	raw[key] = json.RawMessage(b)
	return nil
}

// setJSONBool — same as setJSONString for bool.
func setJSONBool(raw map[string]json.RawMessage, key string, v bool) error {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", key, err)
	}
	raw[key] = json.RawMessage(b)
	return nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "...(truncated)"
}
