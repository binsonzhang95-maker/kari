package execpolicy

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMatchArgv(t *testing.T) {
	cases := []struct {
		name    string
		pattern []string
		argv    []string
		want    bool
	}{
		{"exact 2 elem match", []string{"git", "status"}, []string{"git", "status"}, true},
		{"exact 2 elem mismatch suffix", []string{"git", "status"}, []string{"git", "diff"}, false},
		{"exact 2 elem extra arg", []string{"git", "status"}, []string{"git", "status", "-uno"}, false},
		{"trailing wildcard zero args", []string{"npm", "*"}, []string{"npm"}, true}, // "*" means zero-or-more; npm alone is allowed
		{"trailing wildcard one extra", []string{"npm", "*"}, []string{"npm", "install"}, true},
		{"trailing wildcard many extras", []string{"npm", "*"}, []string{"npm", "install", "react", "--save"}, true},
		{"trailing wildcard after prefix", []string{"cargo", "build", "*"}, []string{"cargo", "build", "--release"}, true},
		{"trailing wildcard exact prefix", []string{"cargo", "build", "*"}, []string{"cargo", "build"}, true},
		{"trailing wildcard mismatched prefix", []string{"cargo", "test", "*"}, []string{"cargo", "build", "--release"}, false},
		{"empty pattern denies", []string{}, []string{"npm"}, false},
		{"empty argv denies", []string{"npm", "*"}, []string{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchArgv(tc.pattern, tc.argv); got != tc.want {
				t.Fatalf("matchArgv(%v, %v) = %v, want %v", tc.pattern, tc.argv, got, tc.want)
			}
		})
	}
}

func TestMatchWorkspace(t *testing.T) {
	if !matchWorkspace("*", "anything") {
		t.Fatal("wildcard should match any workspace")
	}
	if !matchWorkspace("", "anything") {
		t.Fatal("empty pattern should match any workspace")
	}
	if !matchWorkspace("ws-a", "ws-a") {
		t.Fatal("exact match should succeed")
	}
	if matchWorkspace("ws-a", "ws-b") {
		t.Fatal("non-matching workspace should fail")
	}
}

func TestFilterEnv(t *testing.T) {
	overlay := map[string]string{
		"NODE_ENV":              "production",
		"CI":                    "1",
		"PATH":                  "/tmp/evil:/usr/bin",
		"LD_PRELOAD":            "/tmp/evil.so",
		"LD_LIBRARY_PATH":       "/tmp/evil",
		"DYLD_INSERT_LIBRARIES": "/tmp/evil.dylib",
		"NOT_IN_WHITELIST":      "x",
	}
	got := filterEnv(overlay, []string{"NODE_ENV", "CI", "PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "LD_LIBRARY_PATH"}, true)
	want := map[string]string{
		"NODE_ENV": "production",
		"CI":       "1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filterEnv() = %v, want %v", got, want)
	}
}

func TestFilterEnvEmptyAllowList(t *testing.T) {
	overlay := map[string]string{"NODE_ENV": "production"}
	got := filterEnv(overlay, nil, false)
	if got != nil {
		t.Fatalf("filterEnv with empty allow list should return nil, got %v", got)
	}
}

func TestMatchDeniesEmptyArgv(t *testing.T) {
	policy := &Policy{Rules: []Rule{{Workspace: "*", AllowArgv: [][]string{{"npm", "*"}}}}}
	d := Match(policy, "ws", nil, nil)
	if d.Allow || d.DeniedReason != DeniedEmptyArgv {
		t.Fatalf("expected DeniedEmptyArgv, got %+v", d)
	}
}

func TestMatchDeniesNoRuleMatch(t *testing.T) {
	policy := &Policy{Rules: []Rule{{Workspace: "*", AllowArgv: [][]string{{"npm", "*"}}}}}
	d := Match(policy, "ws", []string{"rm", "-rf", "/"}, nil)
	if d.Allow || d.DeniedReason != DeniedNoMatch {
		t.Fatalf("expected DeniedNoMatch, got %+v", d)
	}
}

func TestMatchDenyArgvTakesPrecedenceOverAllow(t *testing.T) {
	policy := &Policy{Rules: []Rule{{
		Workspace: "*",
		DenyArgv:  [][]string{{"rm", "-rf", "/"}},
		AllowArgv: [][]string{{"*"}},
	}}}
	d := Match(policy, "ws", []string{"rm", "-rf", "/"}, nil)
	if d.Allow || d.DeniedReason != DeniedExplicit || d.MatchedRule != 0 {
		t.Fatalf("expected explicit deny from rule 0, got %+v", d)
	}
}

func TestMatchDenyArgvCatchAllAllowsOtherCommands(t *testing.T) {
	policy := &Policy{Rules: []Rule{{
		Workspace: "*",
		DenyArgv:  [][]string{{"rm", "-rf", "/"}},
		AllowArgv: [][]string{{"*"}},
	}}}
	d := Match(policy, "ws", []string{"npm", "run", "build"}, nil)
	if !d.Allow {
		t.Fatalf("expected catch-all allow for npm build, got %+v", d)
	}
}

func TestMatchDenyArgvRespectsWorkspace(t *testing.T) {
	policy := &Policy{Rules: []Rule{
		{Workspace: "ws-a", DenyArgv: [][]string{{"npm", "*"}}, AllowArgv: [][]string{{"*"}}},
		{Workspace: "*", AllowArgv: [][]string{{"*"}}},
	}}
	if d := Match(policy, "ws-a", []string{"npm", "test"}, nil); d.Allow || d.DeniedReason != DeniedExplicit {
		t.Fatalf("expected ws-a npm to be explicitly denied, got %+v", d)
	}
	if d := Match(policy, "ws-b", []string{"npm", "test"}, nil); !d.Allow {
		t.Fatalf("expected ws-b npm to be allowed by fallback rule, got %+v", d)
	}
}

func TestMatchFirstRuleWins(t *testing.T) {
	policy := &Policy{
		MaxTimeoutSeconds:  120,
		CancelGraceSeconds: 7,
		Rules: []Rule{
			{Workspace: "ws-a", AllowArgv: [][]string{{"npm", "*"}}, AllowEnv: []string{"NODE_ENV"}},
			{Workspace: "*", AllowArgv: [][]string{{"npm", "*"}}, AllowEnv: []string{"CI"}},
		},
	}
	d := Match(policy, "ws-a", []string{"npm", "install"}, map[string]string{"NODE_ENV": "production", "CI": "1"})
	if !d.Allow {
		t.Fatalf("expected allow, got %+v", d)
	}
	if d.MatchedRule != 0 {
		t.Fatalf("expected rule 0 to win, got %d", d.MatchedRule)
	}
	if _, ok := d.AllowedEnv["NODE_ENV"]; !ok {
		t.Fatalf("expected NODE_ENV to survive, got %v", d.AllowedEnv)
	}
	if _, ok := d.AllowedEnv["CI"]; ok {
		t.Fatalf("CI should be filtered out by rule 0, got %v", d.AllowedEnv)
	}
	if d.MaxTimeoutSeconds != 120 || d.CancelGraceSeconds != 7 {
		t.Fatalf("timeouts not propagated, got %+v", d)
	}
}

func TestMatchPathPrepend(t *testing.T) {
	policy := &Policy{Rules: []Rule{
		{Workspace: "*", AllowArgv: [][]string{{"npm", "*"}}, AllowEnv: []string{"PATH"}, AllowPathPrepend: true},
	}}
	d := Match(policy, "ws", []string{"npm", "install"}, map[string]string{"PATH": "/opt/special/bin"})
	if !d.Allow {
		t.Fatalf("expected allow, got %+v", d)
	}
	if d.PathOverlay != "/opt/special/bin" {
		t.Fatalf("expected PathOverlay=/opt/special/bin, got %q", d.PathOverlay)
	}
	if _, ok := d.AllowedEnv["PATH"]; ok {
		t.Fatalf("PATH should not appear in AllowedEnv (handled via PathOverlay), got %v", d.AllowedEnv)
	}
}

func TestMatchPathPrependDeniedWhenFlagOff(t *testing.T) {
	policy := &Policy{Rules: []Rule{
		{Workspace: "*", AllowArgv: [][]string{{"npm", "*"}}, AllowEnv: []string{"PATH"}, AllowPathPrepend: false},
	}}
	d := Match(policy, "ws", []string{"npm", "install"}, map[string]string{"PATH": "/opt/evil/bin"})
	if !d.Allow {
		t.Fatalf("expected allow (argv matches), got %+v", d)
	}
	if d.PathOverlay != "" {
		t.Fatalf("PATH overlay should be empty when allow_path_prepend=false, got %q", d.PathOverlay)
	}
}

func TestLoaderFailClosedOnMissingFile(t *testing.T) {
	l := NewLoader(filepath.Join(t.TempDir(), "does-not-exist.json"))
	_, err := l.Load()
	if err == nil {
		t.Fatal("expected load error on missing file")
	}
	d := l.Decide("ws", []string{"npm", "install"}, nil)
	if d.Allow || d.DeniedReason != DeniedPolicyLoad {
		t.Fatalf("expected DeniedPolicyLoad on missing file, got %+v", d)
	}
}

func TestLoaderFailClosedOnMalformedJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exec-policy.json")
	if err := os.WriteFile(path, []byte("{ not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}
	l := NewLoader(path)
	_, err := l.Load()
	if err == nil {
		t.Fatal("expected load error on malformed json")
	}
	d := l.Decide("ws", []string{"npm", "install"}, nil)
	if d.Allow || d.DeniedReason != DeniedPolicyLoad {
		t.Fatalf("expected DeniedPolicyLoad on malformed json, got %+v", d)
	}
}

func TestLoaderHotReloadOnMtimeChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exec-policy.json")
	v1 := `{"version":1,"default":"deny","rules":[{"workspace":"*","allow_argv":[["npm","*"]]}]}`
	if err := os.WriteFile(path, []byte(v1), 0o600); err != nil {
		t.Fatal(err)
	}
	l := NewLoader(path)
	if d := l.Decide("ws", []string{"npm", "install"}, nil); !d.Allow {
		t.Fatalf("v1 should allow npm, got %+v", d)
	}
	if d := l.Decide("ws", []string{"cargo", "build"}, nil); d.Allow {
		t.Fatalf("v1 should deny cargo, got %+v", d)
	}
	// Rewrite the policy file with a different rule and a deliberately
	// later mtime (some filesystems have second-resolution mtime and the
	// write above can land in the same second, masking the change).
	v2 := `{"version":1,"default":"deny","rules":[{"workspace":"*","allow_argv":[["cargo","*"]]}]}`
	if err := os.WriteFile(path, []byte(v2), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := bumpMtime(path); err != nil {
		t.Fatal(err)
	}
	if d := l.Decide("ws", []string{"cargo", "build"}, nil); !d.Allow {
		t.Fatalf("v2 should allow cargo after reload, got %+v", d)
	}
	if d := l.Decide("ws", []string{"npm", "install"}, nil); d.Allow {
		t.Fatalf("v2 should deny npm after reload, got %+v", d)
	}
}

func TestLoaderUnsupportedDefault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exec-policy.json")
	// "allow" as default would invert the safety model; loader must refuse.
	body := `{"version":1,"default":"allow","rules":[]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	l := NewLoader(path)
	if _, err := l.Load(); err == nil {
		t.Fatal("expected error on unsupported default policy")
	}
}

func TestDefaultPolicyAllowsCommonCommandAndBlocksDangerousCommand(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exec-policy.json")
	if err := os.WriteFile(path, DefaultPolicyJSON(), 0o600); err != nil {
		t.Fatal(err)
	}
	l := NewLoader(path)
	if d := l.Decide("ws", []string{"npm", "run", "build"}, nil); !d.Allow {
		t.Fatalf("default policy should allow npm build, got %+v", d)
	}
	if d := l.Decide("ws", []string{"rm", "-rf", "/"}, nil); d.Allow || d.DeniedReason != DeniedExplicit {
		t.Fatalf("default policy should deny rm -rf /, got %+v", d)
	}
}

func TestEnsureDefaultPolicyFileWritesOnlyWhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "exec-policy.json")
	if err := EnsureDefaultPolicyFile(path); err != nil {
		t.Fatal(err)
	}
	l := NewLoader(path)
	if d := l.Decide("ws", []string{"go", "test", "./..."}, nil); !d.Allow {
		t.Fatalf("created default policy should allow go test, got %+v", d)
	}
	custom := []byte(`{"version":1,"default":"deny","rules":[{"workspace":"*","allow_argv":[["cargo","*"]]}]}`)
	if err := os.WriteFile(path, custom, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDefaultPolicyFile(path); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(custom) {
		t.Fatalf("EnsureDefaultPolicyFile overwrote existing policy:\n%s", got)
	}
}

func TestCapMaxTimeout(t *testing.T) {
	p := &Policy{MaxTimeoutSeconds: 60}
	if got := p.CapMaxTimeout(0); got.Seconds() != 60 {
		t.Fatalf("requested=0 should yield policy default, got %v", got)
	}
	if got := p.CapMaxTimeout(120); got.Seconds() != 60 {
		t.Fatalf("requested>max should clamp, got %v", got)
	}
	if got := p.CapMaxTimeout(30); got.Seconds() != 30 {
		t.Fatalf("requested<max should pass through, got %v", got)
	}
}
