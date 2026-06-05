package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
)

// MCP JSON-RPC 2.0 over stdio per spec rev 2024-11-05.
// One message per line on stdin/stdout. We implement the three methods
// Claude/Codex use during a session — initialize, tools/list, tools/call —
// and a couple of notifications. Anything else gets a method_not_found
// error, which is the spec-compliant behaviour and keeps surface area
// small.

const protocolVersion = "2024-11-05"

type jsonrpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"` // raw because IDs may be int or string
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonrpcError   `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

const (
	jrErrParseError     = -32700
	jrErrInvalidRequest = -32600
	jrErrMethodNotFound = -32601
	jrErrInvalidParams  = -32602
	jrErrInternal       = -32603
)

type mcpServer struct {
	debug     bool
	serverAPI serverAPI
	bridgeID  string

	writeMu sync.Mutex
	writer  *bufio.Writer
}

// serverAPI is the interface the bridge needs from its server-loopback
// client. Kept narrow so the stdio loop is easy to unit-test with a
// stub serverAPI.
type serverAPI interface {
	RouteLocalExec(ctx context.Context, bridgeID string, argv []string, cwd string, timeoutSeconds int) (LocalExecResult, error)
}

func (s *mcpServer) Run(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	s.writer = bufio.NewWriter(stdout)
	defer s.writer.Flush()
	scanner := bufio.NewScanner(stdin)
	// Allow large messages (Claude's prompts and tool results can run
	// well over the default 64 KiB).
	scanner.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		raw := scanner.Bytes()
		if len(raw) == 0 {
			continue
		}
		var msg jsonrpcMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			s.respondError(nil, jrErrParseError, "parse error: "+err.Error(), nil)
			continue
		}
		if s.debug {
			log.Printf("recv: %s", string(raw))
		}
		s.dispatch(ctx, &msg)
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func (s *mcpServer) dispatch(ctx context.Context, msg *jsonrpcMessage) {
	if msg.Method == "" {
		// Result-only messages aren't expected from the client; ignore.
		return
	}
	switch msg.Method {
	case "initialize":
		s.handleInitialize(msg)
	case "notifications/initialized":
		// Spec-defined notification; no reply expected.
	case "tools/list":
		s.handleToolsList(msg)
	case "tools/call":
		// Tool calls can run for minutes. Keep the stdio reader free so
		// EOF from the parent MCP client is observed immediately; main's
		// deferred unregister then cancels any in-flight local exec.
		msgCopy := *msg
		go s.handleToolsCall(ctx, &msgCopy)
	case "ping":
		s.respondResult(msg.ID, map[string]any{})
	case "shutdown", "exit":
		// Some clients send these; just no-op + let the parent process
		// signal us to exit.
	default:
		s.respondError(msg.ID, jrErrMethodNotFound, "method not found: "+msg.Method, nil)
	}
}

func (s *mcpServer) handleInitialize(msg *jsonrpcMessage) {
	result := map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities": map[string]any{
			"tools": map[string]any{
				"listChanged": false,
			},
		},
		"serverInfo": map[string]any{
			"name":    "kari-local-shell-bridge",
			"version": "1",
		},
		"instructions": instructionsForLLM,
	}
	s.respondResult(msg.ID, result)
}

// instructionsForLLM is the optional `instructions` field the server
// sends back during initialize. Claude surfaces this in its tool-aware
// context so the model knows when local_shell_exec is the right tool.
// Worded to nudge the model toward picking it for builds/tests/local
// inspection without overpromising — the user's allowlist may still
// reject any specific command.
const instructionsForLLM = `When you need to run a shell command on the user's local desktop machine — to build, test, inspect files, or use the user's installed toolchain or secrets — call local_shell_exec. The user has a strict allowlist of permitted commands; if a command is denied, surface the reason to the user rather than retrying with workarounds. Prefer local_shell_exec over your built-in Bash for anything that depends on the user's local environment, since this server is a remote sandbox.`

func (s *mcpServer) handleToolsList(msg *jsonrpcMessage) {
	tool := map[string]any{
		"name":        "local_shell_exec",
		"description": "Execute a shell command on the user's local desktop machine via the Kari bridge. Use this for any operation that requires the user's local environment, installed toolchains, secrets, or filesystem — including builds (npm/cargo/make), tests, and inspecting local files. The user has a strict allowlist; commands outside it return a `denied` status with a reason. cwd is relative to the workspace root. Returns stdout, stderr, exit_code, and a `truncated` flag if output exceeded limits.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"argv": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"minItems":    1,
					"description": "Argv-style command. argv[0] is the program (resolved via the daemon's PATH), the rest are arguments. There is no shell interpretation — no globbing, no env substitution. Quote nothing.",
				},
				"cwd": map[string]any{
					"type":        "string",
					"description": "Optional working directory, relative to the workspace root. Must stay inside the workspace (symlink-resolved). Defaults to the workspace root.",
				},
				"timeout_seconds": map[string]any{
					"type":        "number",
					"description": "Optional max runtime in seconds. The user's policy caps this; values above the cap are silently clamped.",
				},
			},
			"required": []string{"argv"},
		},
	}
	s.respondResult(msg.ID, map[string]any{"tools": []any{tool}})
}

func (s *mcpServer) handleToolsCall(ctx context.Context, msg *jsonrpcMessage) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		s.respondError(msg.ID, jrErrInvalidParams, "invalid params: "+err.Error(), nil)
		return
	}
	if params.Name != "local_shell_exec" {
		s.respondError(msg.ID, jrErrMethodNotFound, "unknown tool: "+params.Name, nil)
		return
	}
	var args struct {
		Argv           []string `json:"argv"`
		CWD            string   `json:"cwd"`
		TimeoutSeconds int      `json:"timeout_seconds"`
	}
	if err := json.Unmarshal(params.Arguments, &args); err != nil {
		s.respondError(msg.ID, jrErrInvalidParams, "invalid arguments: "+err.Error(), nil)
		return
	}
	if len(args.Argv) == 0 {
		s.toolErrorResult(msg.ID, "argv must be a non-empty array of strings")
		return
	}

	result, err := s.serverAPI.RouteLocalExec(ctx, s.bridgeID, args.Argv, args.CWD, args.TimeoutSeconds)
	if err != nil {
		s.toolErrorResult(msg.ID, "bridge: "+err.Error())
		return
	}

	// MCP tool result: a content array (we use one text item with a
	// structured summary) plus the standard isError flag. We include
	// a small leading status line so the LLM can react quickly without
	// parsing the full body, then the raw stdout/stderr.
	body := formatToolResult(result)
	s.respondResult(msg.ID, map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": body},
		},
		"isError": result.DeniedReason != "" || result.ExitCode != 0 || result.Error != "",
	})
}

func formatToolResult(r LocalExecResult) string {
	out := ""
	if r.DeniedReason != "" {
		out += fmt.Sprintf("status: denied (%s)\n", r.DeniedReason)
		if r.Error != "" {
			out += "error: " + r.Error + "\n"
		}
		return out
	}
	out += fmt.Sprintf("status: exit_code=%d duration_ms=%d output_bytes=%d", r.ExitCode, r.DurationMS, r.OutputBytes)
	if r.Truncated {
		out += fmt.Sprintf(" truncated=%s", r.TruncatedReason)
	}
	out += "\n"
	if r.Error != "" {
		out += "error: " + r.Error + "\n"
	}
	if len(r.Stdout) > 0 {
		out += "--- stdout ---\n" + string(r.Stdout)
		if len(r.Stdout) > 0 && r.Stdout[len(r.Stdout)-1] != '\n' {
			out += "\n"
		}
	}
	if len(r.Stderr) > 0 {
		out += "--- stderr ---\n" + string(r.Stderr)
		if len(r.Stderr) > 0 && r.Stderr[len(r.Stderr)-1] != '\n' {
			out += "\n"
		}
	}
	return out
}

func (s *mcpServer) toolErrorResult(id json.RawMessage, message string) {
	s.respondResult(id, map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": message},
		},
		"isError": true,
	})
}

func (s *mcpServer) respondResult(id json.RawMessage, result any) {
	payload, err := json.Marshal(result)
	if err != nil {
		s.respondError(id, jrErrInternal, "marshal result: "+err.Error(), nil)
		return
	}
	s.writeMessage(jsonrpcMessage{
		JSONRPC: "2.0",
		ID:      id,
		Result:  payload,
	})
}

func (s *mcpServer) respondError(id json.RawMessage, code int, message string, data any) {
	var dataRaw json.RawMessage
	if data != nil {
		if b, err := json.Marshal(data); err == nil {
			dataRaw = b
		}
	}
	s.writeMessage(jsonrpcMessage{
		JSONRPC: "2.0",
		ID:      id,
		Error: &jsonrpcError{
			Code:    code,
			Message: message,
			Data:    dataRaw,
		},
	})
}

func (s *mcpServer) writeMessage(msg jsonrpcMessage) {
	if msg.JSONRPC == "" {
		msg.JSONRPC = "2.0"
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal jsonrpc: %v", err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.writer.Write(data); err != nil {
		log.Printf("write jsonrpc: %v", err)
		return
	}
	if err := s.writer.WriteByte('\n'); err != nil {
		log.Printf("write newline: %v", err)
		return
	}
	if err := s.writer.Flush(); err != nil {
		log.Printf("flush: %v", err)
	}
	if s.debug {
		log.Printf("send: %s", string(data))
	}
}
