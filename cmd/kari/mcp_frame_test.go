package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

func TestWriteMCPSessionFrame(t *testing.T) {
	var b strings.Builder
	writeMCPSessionFrame(&b, &transport.MCPSessionInfo{TerminalID: "term_1", ContextPath: "/tmp/context.json", MCPConfigPath: "/etc/kari/mcp/claude.json"})
	out := b.String()
	if !strings.HasPrefix(out, kariMCPSessionOSCPrefix) || !strings.HasSuffix(out, "") {
		t.Fatalf("frame = %q", out)
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(out, kariMCPSessionOSCPrefix), "")
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var info transport.MCPSessionInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		t.Fatal(err)
	}
	if info.TerminalID != "term_1" || info.ContextPath != "/tmp/context.json" || info.MCPConfigPath != "/etc/kari/mcp/claude.json" {
		t.Fatalf("info = %+v", info)
	}
}
