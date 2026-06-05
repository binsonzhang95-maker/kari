package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// LocalExecResult is what the loopback endpoint returns to the bridge
// after running one MCP tool call to completion. The server collects
// streaming output from the daemon into Stdout/Stderr and includes the
// terminal LocalExecDone fields. Capping happens daemon-side; here we
// just relay.
type LocalExecResult struct {
	ExitCode        int    `json:"exit_code"`
	DurationMS      int64  `json:"duration_ms"`
	DeniedReason    string `json:"denied_reason,omitempty"`
	Error           string `json:"error,omitempty"`
	Truncated       bool   `json:"truncated,omitempty"`
	TruncatedReason string `json:"truncated_reason,omitempty"`
	OutputBytes     int64  `json:"output_bytes,omitempty"`
	Stdout          []byte `json:"stdout,omitempty"`
	Stderr          []byte `json:"stderr,omitempty"`
}

// localExecRequestEnvelope is what the bridge POSTs to /v1/local-exec/run.
// Kept separate from the on-wire transport.LocalExecRequest because the
// fields the bridge knows about are a strict subset (no RequestID — the
// server generates one — no EnvOverlay yet — the bridge layer doesn't
// surface that to the MCP schema).
type localExecRequestEnvelope struct {
	BridgeID       string   `json:"bridge_id"`
	Argv           []string `json:"argv"`
	CWD            string   `json:"cwd,omitempty"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
}

type bridgeRegistrationRequest struct {
	WorkspaceID string `json:"workspace_id"`
	ClientID    string `json:"client_id"`
	TerminalID  string `json:"terminal_id"`
}

type bridgeRegistrationResponse struct {
	BridgeID string `json:"bridge_id"`
}

type serverClient struct {
	serverAddr   string
	serverSocket string
	token        string
	workspaceID  string
	clientID     string
	terminalID   string
	httpClient   *http.Client
	registerPath string
	runPath      string
}

func newServerClient(serverAddr, serverSocket, token, workspaceID, clientID, terminalID string) *serverClient {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if serverSocket != "" {
		socketPath := serverSocket
		transport.DisableKeepAlives = true
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		}
	}
	return &serverClient{
		serverAddr:   serverAddr,
		serverSocket: serverSocket,
		token:        token,
		workspaceID:  workspaceID,
		clientID:     clientID,
		terminalID:   terminalID,
		httpClient:   &http.Client{Transport: transport, Timeout: 0}, // long-running tool calls; per-request ctx governs
		registerPath: "/v1/local-exec/register",
		runPath:      "/v1/local-exec/run",
	}
}

func (c *serverClient) RegisterBridge(ctx context.Context) (string, error) {
	body := bridgeRegistrationRequest{WorkspaceID: c.workspaceID, ClientID: c.clientID, TerminalID: c.terminalID}
	var out bridgeRegistrationResponse
	if err := c.doJSON(ctx, c.registerPath, body, &out, 10*time.Second); err != nil {
		return "", err
	}
	if out.BridgeID == "" {
		return "", fmt.Errorf("server returned empty bridge_id")
	}
	return out.BridgeID, nil
}

func (c *serverClient) UnregisterBridge(ctx context.Context, bridgeID string) {
	// Best-effort. Even on error the server will eventually time the
	// bridge out (or the daemon-side cancel fires when the desktop
	// notices the originating Claude PTY died).
	body := map[string]string{"bridge_id": bridgeID}
	_ = c.doJSON(ctx, c.registerPath+"/release", body, nil, 5*time.Second)
}

func (c *serverClient) RouteLocalExec(ctx context.Context, bridgeID string, argv []string, cwd string, timeoutSeconds int) (LocalExecResult, error) {
	body := localExecRequestEnvelope{
		BridgeID:       bridgeID,
		Argv:           argv,
		CWD:            cwd,
		TimeoutSeconds: timeoutSeconds,
	}
	var result LocalExecResult
	// No per-call client timeout — the LLM may legitimately want to wait
	// for a multi-minute build. Cancellation flows via ctx, which the
	// stdio loop wires to the parent context (SIGTERM → cancel).
	if err := c.doJSON(ctx, c.runPath, body, &result, 0); err != nil {
		return LocalExecResult{}, err
	}
	return result, nil
}

func (c *serverClient) doJSON(ctx context.Context, path string, body, out any, timeout time.Duration) error {
	url := c.baseURL() + path
	var rdr io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(data)
	}
	reqCtx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(reqCtx, "POST", url, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return fmt.Errorf("server returned %d: %s", resp.StatusCode, string(respBody))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *serverClient) baseURL() string {
	if c.serverSocket != "" {
		// The host is ignored by the unix-socket DialContext above, but
		// net/http still requires an absolute URL with a syntactic host.
		return "http://unix"
	}
	return "http://" + c.serverAddr
}
