package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

const bridgeContextSchemaVersion = 1

type bridgeConfig struct {
	WorkspaceID  string
	ClientID     string
	TerminalID   string
	ServerSocket string
	ServerAddr   string
	TokenFile    string
	Debug        bool
}

type bridgeContextFile struct {
	SchemaVersion int    `json:"schema_version"`
	WorkspaceID   string `json:"workspace_id"`
	ClientID      string `json:"client_id"`
	TerminalID    string `json:"terminal_id"`
	ServerSocket  string `json:"server_socket"`
	ServerAddr    string `json:"server_addr"`
	TokenFile     string `json:"token_file"`
}

func resolveBridgeConfig(workspaceID, clientID, terminalID, serverAddr, serverSocket, tokenFile string, debug bool) (bridgeConfig, error) {
	if contextPath := strings.TrimSpace(os.Getenv("KARI_MCP_CONTEXT")); contextPath != "" {
		if debug {
			// Context mode is authoritative: the server wrote the file
			// beside the PTY session, so command-line endpoint flags are
			// intentionally ignored to avoid cross-session token reuse.
			fmt.Fprintf(os.Stderr, "kari-mcp-bridge: KARI_MCP_CONTEXT set; ignoring endpoint flags\n")
		}
		cfg, err := readBridgeContext(contextPath)
		if err != nil {
			return bridgeConfig{}, err
		}
		cfg.Debug = debug
		return cfg, nil
	}
	cfg := bridgeConfig{
		WorkspaceID:  strings.TrimSpace(workspaceID),
		ClientID:     strings.TrimSpace(clientID),
		TerminalID:   strings.TrimSpace(terminalID),
		ServerSocket: strings.TrimSpace(serverSocket),
		ServerAddr:   strings.TrimSpace(serverAddr),
		TokenFile:    strings.TrimSpace(tokenFile),
		Debug:        debug,
	}
	if err := validateBridgeConfig(cfg, "flags"); err != nil {
		return bridgeConfig{}, err
	}
	return cfg, nil
}

func readBridgeContext(path string) (bridgeConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return bridgeConfig{}, fmt.Errorf("read KARI_MCP_CONTEXT %s: %w", path, err)
	}
	var in bridgeContextFile
	if err := json.Unmarshal(data, &in); err != nil {
		return bridgeConfig{}, fmt.Errorf("parse KARI_MCP_CONTEXT %s: %w", path, err)
	}
	// schema_version must match exactly. If a future v2 is truly
	// backward-compatible with old bridge binaries, this can be relaxed
	// to reject only versions greater than bridgeContextSchemaVersion.
	if in.SchemaVersion != bridgeContextSchemaVersion {
		return bridgeConfig{}, fmt.Errorf("KARI_MCP_CONTEXT schema_version=%d, want %d", in.SchemaVersion, bridgeContextSchemaVersion)
	}
	cfg := bridgeConfig{
		WorkspaceID:  strings.TrimSpace(in.WorkspaceID),
		ClientID:     strings.TrimSpace(in.ClientID),
		TerminalID:   strings.TrimSpace(in.TerminalID),
		ServerSocket: strings.TrimSpace(in.ServerSocket),
		ServerAddr:   strings.TrimSpace(in.ServerAddr),
		TokenFile:    strings.TrimSpace(in.TokenFile),
	}
	if err := validateBridgeConfig(cfg, "KARI_MCP_CONTEXT"); err != nil {
		return bridgeConfig{}, err
	}
	if cfg.TerminalID == "" {
		return bridgeConfig{}, errors.New("KARI_MCP_CONTEXT missing terminal_id")
	}
	return cfg, nil
}

func validateBridgeConfig(cfg bridgeConfig, source string) error {
	var missing []string
	if cfg.WorkspaceID == "" {
		missing = append(missing, "workspace_id")
	}
	if cfg.ClientID == "" {
		missing = append(missing, "client_id")
	}
	if cfg.TerminalID == "" {
		missing = append(missing, "terminal_id")
	}
	if cfg.ServerSocket == "" && cfg.ServerAddr == "" {
		missing = append(missing, "server_socket or server_addr")
	}
	if cfg.TokenFile == "" {
		missing = append(missing, "token_file")
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s missing %s", source, strings.Join(missing, ", "))
	}
	return nil
}
