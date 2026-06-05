package syncthing

import (
	"context"
	"errors"
	"sort"
	"sync"
)

// FakeClient is an in-memory Client implementation for tests. It is
// the only Client implementation in this package today; the real REST
// client lands together with sidecar lifecycle in a later PR.
//
// FakeClient satisfies Client and is safe for concurrent use.
//
// Two patterns of test customisation are supported:
//
//  1. Seed initial state via direct PutFolder / SetOptions calls
//     before the System Under Test starts running.
//
//  2. Inject errors on the next call via SetGetConfigError /
//     SetPutFolderError / SetPutOptionsError. Errors are sticky until
//     cleared by setting them back to nil. Use ErrInjectionFunc-style
//     hooks if you need per-call patterns; those can be added when a
//     test needs them.
type FakeClient struct {
	mu             sync.Mutex
	folders        map[string]Folder
	devices        map[string]Device // server's view of all known devices
	options        ConfigOptions
	getErr         error
	putErr         error
	putOptionsErr  error
	putCalls       int
	putOptionsHits int

	// putFolderHook, if non-nil, is called from inside PutFolder
	// after Folder.Validate succeeds and BEFORE the SetPutFolderError
	// check. Fires outside the FakeClient mutex so the hook may
	// block on channels / sleep without freezing the rest of the
	// fake. A non-nil return is propagated to the PutFolder caller
	// AS-IS (state is not mutated, putCalls is bumped) — the hook
	// is the simulated REST round-trip.
	putFolderHook func(Folder) error
}

// NewFakeClient returns an empty FakeClient. No folders, no devices,
// all global options at zero (which happens to match the "fail-closed
// safe" set: all announces / relay / NAT off).
func NewFakeClient() *FakeClient {
	return &FakeClient{
		folders: map[string]Folder{},
		devices: map[string]Device{},
	}
}

// GetConfig returns a deep-ish copy of the current state. Folder
// devices are copied so callers can mutate the returned slice without
// racing against subsequent PutFolder calls. Folders are returned
// sorted by ID for deterministic test output.
func (c *FakeClient) GetConfig(ctx context.Context) (*Config, error) {
	if ctx == nil {
		return nil, errors.New("syncthing.FakeClient: nil context")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.getErr != nil {
		return nil, c.getErr
	}

	cfg := &Config{Options: c.options}
	cfg.Folders = make([]Folder, 0, len(c.folders))
	for _, f := range c.folders {
		cfg.Folders = append(cfg.Folders, cloneFolder(f))
	}
	sort.Slice(cfg.Folders, func(i, j int) bool {
		return cfg.Folders[i].ID < cfg.Folders[j].ID
	})
	cfg.Devices = make([]Device, 0, len(c.devices))
	for _, d := range c.devices {
		cfg.Devices = append(cfg.Devices, d)
	}
	sort.Slice(cfg.Devices, func(i, j int) bool {
		return cfg.Devices[i].DeviceID < cfg.Devices[j].DeviceID
	})

	return cfg, nil
}

// PutFolder records the folder write atomically. The call sequence
// is:
//
//  1. ctx validity check (nil / cancelled). Failure does NOT count as
//     a PutCalls attempt — we never reached the "REST call" stage.
//  2. Folder.Validate(). Same pre-call category as (1); does NOT
//     count toward PutCalls. The real REST endpoint would 400 here.
//  3. Injected error check (SetPutFolderError). DOES count toward
//     PutCalls — the request was actually sent. Returns the injected
//     error without mutating state, matching the real "PUT landed or
//     didn't" semantics.
//  4. Successful write: store the folder, update derived device list,
//     increment PutCalls.
func (c *FakeClient) PutFolder(ctx context.Context, folder Folder) error {
	if ctx == nil {
		return errors.New("syncthing.FakeClient: nil context")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := folder.Validate(); err != nil {
		return err
	}

	// Fire the hook (if any) OUTSIDE the mutex so hooks that block
	// on channels / sleep don't freeze concurrent GetConfig /
	// PutOptions calls. The hook represents the simulated REST
	// round-trip: returning an error here is equivalent to the real
	// REST 5xx, which we propagate to the caller and count as a
	// (failed) attempt.
	c.mu.Lock()
	hook := c.putFolderHook
	c.mu.Unlock()
	if hook != nil {
		if err := hook(folder); err != nil {
			c.mu.Lock()
			c.putCalls++
			c.mu.Unlock()
			return err
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.putErr != nil {
		c.putCalls++ // count the attempt even on injected failure
		return c.putErr
	}
	c.folders[folder.ID] = cloneFolder(folder)
	// Track devices observed via folder membership so GetConfig's
	// device list isn't perpetually empty in tests that don't call
	// SetOptions explicitly.
	for _, d := range folder.Devices {
		if _, ok := c.devices[d.DeviceID]; !ok {
			c.devices[d.DeviceID] = d
		}
	}
	c.putCalls++
	return nil
}

// SetPutFolderHook installs a synchronous callback invoked inside
// PutFolder after Folder.Validate succeeds and before
// SetPutFolderError applies. The hook runs OUTSIDE the FakeClient
// mutex, so hooks blocking on channels won't freeze concurrent
// FakeClient calls. Returning a non-nil error from the hook makes
// PutFolder return that error without mutating folder state (putCalls
// is bumped, matching SetPutFolderError semantics).
//
// Used by reconciler concurrency tests to inject a deterministic
// hold-point inside a PutFolder call so a second goroutine can race
// against it. Pass nil to clear.
func (c *FakeClient) SetPutFolderHook(fn func(Folder) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putFolderHook = fn
}

// PutOptions atomically replaces the global Syncthing options. Same
// pre-call validation pattern as PutFolder: ctx errors and injected
// errors don't share the same count category — only the post-validate
// "request actually issued" path bumps PutOptionsCalls.
func (c *FakeClient) PutOptions(ctx context.Context, opts ConfigOptions) error {
	if ctx == nil {
		return errors.New("syncthing.FakeClient: nil context")
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.putOptionsErr != nil {
		c.putOptionsHits++
		return c.putOptionsErr
	}
	c.options = opts
	c.putOptionsHits++
	return nil
}

// SetGetConfigError makes the next (and every subsequent) GetConfig
// call return err. Pass nil to clear.
func (c *FakeClient) SetGetConfigError(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.getErr = err
}

// SetPutFolderError makes the next (and every subsequent) PutFolder
// call return err WITHOUT applying the requested folder write. Pass
// nil to clear. PutCalls() still counts the attempt so tests can
// assert that the retry loop did N attempts before succeeding.
func (c *FakeClient) SetPutFolderError(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putErr = err
}

// SetPutOptionsError makes the next (and every subsequent) PutOptions
// call return err WITHOUT applying the requested options write.
// PutOptionsCalls() still counts the attempt. Pass nil to clear.
func (c *FakeClient) SetPutOptionsError(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putOptionsErr = err
}

// SetOptions seeds / overrides the global ConfigOptions returned by
// GetConfig. Used by reconciler drift tests that need to simulate a
// rogue config write.
func (c *FakeClient) SetOptions(opts ConfigOptions) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.options = opts
}

// PutCalls returns the count of PutFolder invocations (successful +
// errored). Useful for asserting retry behaviour in cold-safety
// tests without time-based brittleness.
func (c *FakeClient) PutCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.putCalls
}

// ResetPutCalls zeroes the put attempt counter. Used at the start of
// a sub-test that wants to reason about call counts independently
// from prior setup.
func (c *FakeClient) ResetPutCalls() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putCalls = 0
}

// PutOptionsCalls returns the count of PutOptions invocations.
func (c *FakeClient) PutOptionsCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.putOptionsHits
}

// Folder returns the current state of a folder by ID, plus an "ok"
// flag like map lookup. The Folder is a copy.
func (c *FakeClient) Folder(id string) (Folder, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	f, ok := c.folders[id]
	if !ok {
		return Folder{}, false
	}
	return cloneFolder(f), true
}

func cloneFolder(f Folder) Folder {
	out := f
	if len(f.Devices) > 0 {
		out.Devices = append([]Device(nil), f.Devices...)
	}
	return out
}

// Compile-time assertion that FakeClient satisfies Client. If a future
// interface change drops a method from FakeClient or adds one without
// implementation, this line breaks the build.
var _ Client = (*FakeClient)(nil)
