package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ensureHostMCPConfig writes a claude.json into cfgDir whose kari_local MCP
// server command points at bridgePath (the resolved host kari-mcp-bridge), and
// returns the config path. It is the host counterpart of the baked-in
// container config (deploy/aicontainer/claude.json) — npm-installed servers
// have the bridge next to the binary but no static config, so the server
// generates one pointing at the actual bridge location. No-op (returns "") when
// bridgePath is empty (bridge not installed). Overwrites an existing file so a
// moved/upgraded bridge path stays correct.
func ensureHostMCPConfig(bridgePath, cfgDir string) (string, error) {
	if bridgePath == "" {
		return "", nil
	}
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		return "", err
	}
	cfg := map[string]any{
		"mcpServers": map[string]any{
			"kari_local": map[string]any{
				"command": bridgePath,
				"args":    []string{},
			},
		},
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(cfgDir, "claude.json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}
