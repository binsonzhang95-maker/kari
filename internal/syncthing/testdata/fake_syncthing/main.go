// fake_syncthing is the test binary the SidecarManager spawns
// instead of a real syncthing process. It implements the minimum
// REST surface (and lifecycle signals) PR1.3b-2's sidecar tests
// need. Real syncthing has thousands of features; this binary has
// the ~6 endpoints + signal behaviours Kari relies on.
//
// Built once per `go test` run from internal/syncthing's TestMain
// helper (NOT vendored as a precompiled binary; the build is part
// of every test invocation). Lives under testdata/ so `go build
// ./...` excludes it from production binaries.
//
// Behaviours pinned today (extend as new tests demand more):
//   - Reads -home flag + config.xml at that path; binds the
//     <gui><address>127.0.0.1:PORT</address> port.
//   - Reads STGUIAPIKEY env. Requests to authenticated endpoints
//     must carry matching X-API-Key.
//   - /rest/noauth/health: 200 always; the sidecar startup probe
//     hits this.
//   - /rest/system/status: 200 + {"myID":"<flag-configurable>"}.
//   - /rest/system/version: 200 + version string (default
//     "v1.27.0", flag-overridable).
//   - On SIGTERM / SIGINT: optionally sleep -sigterm-delay then
//     exit 0. Sleep > sidecar's 5s grace exercises the
//     SIGTERM→SIGKILL escalation path.
//   - On SIGKILL: process dies immediately (Go runtime can't
//     intercept this — confirmed by os semantics).
package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type configXML struct {
	XMLName xml.Name `xml:"configuration"`
	GUI     struct {
		Enabled string `xml:"enabled,attr"`
		Address string `xml:"address"`
	} `xml:"gui"`
}

func main() {
	home := flag.String("home", ".", "syncthing home dir (must contain config.xml)")
	noBrowser := flag.Bool("no-browser", false, "ignored; consumed for flag-compat with real syncthing")
	myID := flag.String("fake-my-id", "FAKE-DEVICE-ID-FOR-TESTS", "value returned from /rest/system/status myID")
	version := flag.String("fake-version", "v1.27.0", "value returned from /rest/system/version version")
	sigtermDelay := flag.Duration("fake-sigterm-delay", 0, "sleep this long after SIGTERM before exiting (test-only knob)")
	flag.Parse()
	_ = noBrowser

	// Read config.xml to learn the listen address.
	cfgPath := filepath.Join(*home, "config.xml")
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fake_syncthing: read config.xml at %s: %v\n", cfgPath, err)
		os.Exit(2)
	}
	var cfg configXML
	if err := xml.Unmarshal(data, &cfg); err != nil {
		fmt.Fprintf(os.Stderr, "fake_syncthing: parse config.xml: %v\n", err)
		os.Exit(2)
	}
	addr := cfg.GUI.Address
	if addr == "" {
		fmt.Fprintf(os.Stderr, "fake_syncthing: config.xml missing <gui><address>\n")
		os.Exit(2)
	}

	apiKey := os.Getenv("STGUIAPIKEY")
	if apiKey == "" {
		fmt.Fprintf(os.Stderr, "fake_syncthing: STGUIAPIKEY env not set\n")
		os.Exit(2)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/rest/noauth/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"status":"OK"}`))
	})

	requireAuth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-API-Key") != apiKey {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
				return
			}
			h(w, r)
		}
	}

	// FAKE_MY_ID env (if set, even to "") overrides the -fake-my-id
	// flag — that's how PR1.3b-4 main-wiring tests drive the D11 (c)
	// empty-MyID hard gate without modifying StartOptions. t.Setenv
	// propagates to the spawned fake binary's environment.
	resolvedMyID := *myID
	if env, present := os.LookupEnv("FAKE_MY_ID"); present {
		resolvedMyID = env
	}
	mux.HandleFunc("/rest/system/status", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"myID":       resolvedMyID,
			"goroutines": 1,
			"alloc":      1024,
		})
	}))

	mux.HandleFunc("/rest/system/version", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": *version,
		})
	}))

	// In-memory config state: folders keyed by ID + the options
	// block. Real syncthing persists to config.xml on every write;
	// the fake just holds it in RAM since each test gets a fresh
	// process. mu guards both maps because PUT and GET races
	// across the reconciler are legitimate.
	type folderStore struct {
		mu      sync.Mutex
		folders map[string]map[string]any
		options map[string]any
	}
	store := &folderStore{
		folders: map[string]map[string]any{},
		options: map[string]any{
			// Kari's pinned defaults (matches PR1.3b-2 minimal config).
			"localAnnounceEnabled":  false,
			"globalAnnounceEnabled": false,
			"relaysEnabled":         false,
			"natEnabled":            false,
		},
	}

	// GET /rest/config — full config snapshot. Reconciler reads
	// this every tick to discover drift.
	mux.HandleFunc("/rest/config", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		store.mu.Lock()
		defer store.mu.Unlock()
		folders := make([]map[string]any, 0, len(store.folders))
		for _, f := range store.folders {
			// Copy to keep in-memory state immutable across response.
			cp := make(map[string]any, len(f))
			for k, v := range f {
				cp[k] = v
			}
			folders = append(folders, cp)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"folders": folders,
			"options": store.options,
			"devices": []map[string]any{}, // top-level devices kept empty
		})
	}))

	// GET /rest/config/folders/<id> — single folder. 404 if absent
	// so the RestClient PutFolder's RMW path triggers the
	// minimal-map fallback.
	// PUT same path — install/replace folder.
	mux.HandleFunc("/rest/config/folders/", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/rest/config/folders/")
		if id == "" {
			w.WriteHeader(400)
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			f, ok := store.folders[id]
			if !ok {
				w.WriteHeader(404)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(f)
		case http.MethodPut:
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				w.WriteHeader(400)
				return
			}
			store.folders[id] = body
			w.WriteHeader(200)
		default:
			w.WriteHeader(405)
		}
	}))

	// GET/PUT /rest/config/options — global options.
	mux.HandleFunc("/rest/config/options", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		store.mu.Lock()
		defer store.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(store.options)
		case http.MethodPut:
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				w.WriteHeader(400)
				return
			}
			store.options = body
			w.WriteHeader(200)
		default:
			w.WriteHeader(405)
		}
	}))

	srv := &http.Server{Addr: addr, Handler: mux}
	listenErr := make(chan error, 1)
	go func() {
		listenErr <- srv.ListenAndServe()
	}()

	// Wait for SIGTERM / SIGINT. SIGKILL bypasses this (Go runtime
	// can't catch it).
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)

	select {
	case sig := <-sigChan:
		// Optional configurable delay before honoring the signal
		// — exercises the SIGTERM→5s→SIGKILL escalation in
		// sidecar Stop tests.
		if *sigtermDelay > 0 {
			time.Sleep(*sigtermDelay)
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = srv.Shutdown(shutdownCtx)
		cancel()
		_ = sig
		os.Exit(0)
	case err := <-listenErr:
		// ListenAndServe returned spontaneously (port in use,
		// addr parse error, etc.). Surface and exit non-zero.
		if err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "fake_syncthing: listen on %s: %v\n", addr, err)
			os.Exit(3)
		}
		os.Exit(0)
	}
}
