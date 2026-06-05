package sessionhistory

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const MaxSessionsPerSource = 200

type Roots struct {
	ClaudeProjects    string
	ClaudeOneProjects string
	CodexSessions     string
}

func HomeRoots(homeDir string) Roots {
	return Roots{
		ClaudeProjects:    filepath.Join(homeDir, ".claude", "projects"),
		ClaudeOneProjects: filepath.Join(homeDir, ".claude-one", "projects"),
		CodexSessions:     filepath.Join(homeDir, ".codex", "sessions"),
	}
}

func ContainerRoots() Roots {
	return Roots{
		ClaudeProjects:    "/root/.claude/projects",
		ClaudeOneProjects: "/root/.claude-one/projects",
		CodexSessions:     "/root/.codex/sessions",
	}
}

func ScanHome(homeDir string, req transport.ListSessionsRequest, workspaceRoot string) transport.ListSessionsResult {
	return ScanRoots(HomeRoots(homeDir), req, workspaceRoot)
}

func ScanRoots(roots Roots, req transport.ListSessionsRequest, workspaceRoot string) transport.ListSessionsResult {
	wanted := map[string]bool{"claude": true, "claude-one": true, "codex": true}
	if len(req.Sources) > 0 {
		wanted = map[string]bool{}
		for _, k := range req.Sources {
			wanted[k] = true
		}
	}
	result := transport.ListSessionsResult{}
	if wanted["claude"] {
		result.Sources = append(result.Sources, scanClaudeStyleForWorkspace("claude", roots.ClaudeProjects, workspaceRoot))
	}
	if wanted["claude-one"] {
		result.Sources = append(result.Sources, scanClaudeStyleForWorkspace("claude-one", roots.ClaudeOneProjects, workspaceRoot))
	}
	if wanted["codex"] {
		result.Sources = append(result.Sources, scanCodexForWorkspace(roots.CodexSessions, workspaceRoot))
	}
	return result
}

func MergeResults(results ...transport.ListSessionsResult) transport.ListSessionsResult {
	byKind := map[string]map[string]transport.SessionEntry{}
	order := []string{}
	errorsByKind := map[string]string{}
	for _, res := range results {
		for _, src := range res.Sources {
			if _, ok := byKind[src.Kind]; !ok {
				byKind[src.Kind] = map[string]transport.SessionEntry{}
				order = append(order, src.Kind)
			}
			if src.Error != "" {
				if errorsByKind[src.Kind] == "" {
					errorsByKind[src.Kind] = src.Error
				} else {
					errorsByKind[src.Kind] += "; " + src.Error
				}
			}
			for _, entry := range src.Sessions {
				if entry.ID == "" {
					continue
				}
				prev, ok := byKind[src.Kind][entry.ID]
				if !ok || entry.ModTime > prev.ModTime {
					if entry.Project == "" {
						entry.Project = prev.Project
					}
					byKind[src.Kind][entry.ID] = entry
					continue
				}
				if prev.Project == "" && entry.Project != "" {
					prev.Project = entry.Project
					byKind[src.Kind][entry.ID] = prev
				}
			}
		}
	}
	out := transport.ListSessionsResult{}
	for _, kind := range order {
		entries := make([]transport.SessionEntry, 0, len(byKind[kind]))
		for _, entry := range byKind[kind] {
			entries = append(entries, entry)
		}
		sortAndCap(&entries)
		out.Sources = append(out.Sources, transport.SessionSource{
			Kind:     kind,
			Sessions: entries,
			Error:    errorsByKind[kind],
		})
	}
	return out
}

func scanClaudeStyleForWorkspace(kind, projectsRoot, workspaceRoot string) transport.SessionSource {
	src := transport.SessionSource{Kind: kind, Sessions: []transport.SessionEntry{}}
	entries, err := os.ReadDir(projectsRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return src
		}
		src.Error = fmt.Sprintf("read %s: %v", projectsRoot, err)
		return src
	}
	encodedWorkspace := encodedWorkspaceRoot(workspaceRoot)
	workspaceProject := projectNameFromWorkspaceRoot(workspaceRoot)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if encodedWorkspace != "" && !encodedCWDInWorkspace(e.Name(), encodedWorkspace) {
			continue
		}
		project := workspaceProject
		if project == "" {
			project = projectBasenameFromEncodedCwd(e.Name())
		}
		dir := filepath.Join(projectsRoot, e.Name())
		files, ferr := os.ReadDir(dir)
		if ferr != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() {
				continue
			}
			name := f.Name()
			if !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			id := strings.TrimSuffix(name, ".jsonl")
			if !uuidRegex.MatchString(id) {
				continue
			}
			info, ierr := f.Info()
			if ierr != nil {
				continue
			}
			src.Sessions = append(src.Sessions, transport.SessionEntry{
				ID:      id,
				Project: project,
				Title:   sessionTitleFromJSONL(filepath.Join(dir, name)),
				ModTime: info.ModTime().UnixNano(),
			})
		}
	}
	sortAndCap(&src.Sessions)
	return src
}

func scanCodexForWorkspace(sessionsRoot, workspaceRoot string) transport.SessionSource {
	src := transport.SessionSource{Kind: "codex", Sessions: []transport.SessionEntry{}}
	if _, err := os.Stat(sessionsRoot); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return src
		}
		src.Error = fmt.Sprintf("stat %s: %v", sessionsRoot, err)
		return src
	}
	walkErr := filepath.WalkDir(sessionsRoot, func(path string, d os.DirEntry, werr error) error {
		if werr != nil || d.IsDir() {
			return nil
		}
		base := d.Name()
		if !strings.HasPrefix(base, "rollout-") || !strings.HasSuffix(base, ".jsonl") {
			return nil
		}
		stem := strings.TrimSuffix(strings.TrimPrefix(base, "rollout-"), ".jsonl")
		if len(stem) < 36 {
			return nil
		}
		id := stem[len(stem)-36:]
		if !uuidRegex.MatchString(id) {
			return nil
		}
		project, ok := codexSessionProjectForWorkspace(path, workspaceRoot)
		if !ok {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		src.Sessions = append(src.Sessions, transport.SessionEntry{
			ID:      id,
			Project: project,
			Title:   sessionTitleFromJSONL(path),
			ModTime: info.ModTime().UnixNano(),
		})
		return nil
	})
	if walkErr != nil {
		src.Error = fmt.Sprintf("walk %s: %v", sessionsRoot, walkErr)
	}
	sortAndCap(&src.Sessions)
	return src
}

func encodedWorkspaceRoot(workspaceRoot string) string {
	workspaceRoot = strings.TrimSpace(workspaceRoot)
	if workspaceRoot == "" {
		return ""
	}
	if real, err := filepath.EvalSymlinks(workspaceRoot); err == nil {
		workspaceRoot = real
	}
	workspaceRoot = filepath.Clean(workspaceRoot)
	// Claude Code names its project dir by replacing EVERY non-alphanumeric
	// char of the cwd with '-' (so '/', '.', '_' all become '-', runs not
	// merged — "/root/.kari-server" -> "-root--kari-server"). Replacing only
	// the path separator kept '.'/'_' literal, so session history never matched
	// the on-disk slug for workspace roots under a dotted/underscored path
	// (e.g. /root/.kari-server/.../mer_java) — claude/codex history showed
	// empty there even though the sessions existed. Mirror Claude's rule.
	var b strings.Builder
	b.Grow(len(workspaceRoot))
	for _, r := range workspaceRoot {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return b.String()
}

func encodedCWDInWorkspace(encodedCWD, encodedWorkspace string) bool {
	return encodedCWD == encodedWorkspace || strings.HasPrefix(encodedCWD, encodedWorkspace+"-")
}

func codexSessionInWorkspace(path, workspaceRoot string) bool {
	_, ok := codexSessionProjectForWorkspace(path, workspaceRoot)
	return ok
}

func codexSessionProjectForWorkspace(path, workspaceRoot string) (string, bool) {
	root := normalizedWorkspacePrefix(workspaceRoot)
	if root == "" {
		return codexSessionProject(path), true
	}
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	workspaceProject := projectNameFromWorkspaceRoot(workspaceRoot)
	for i := 0; i < 80; i++ {
		line, err := reader.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			if cwd := cwdFromCodexLine(line); cwd != "" {
				clean := normalizedWorkspacePath(cwd)
				if clean == strings.TrimSuffix(root, string(os.PathSeparator)) || strings.HasPrefix(clean, root) {
					if workspaceProject != "" {
						return workspaceProject, true
					}
					return filepath.Base(clean), true
				}
				return "", false
			}
		}
		if err != nil {
			return "", false
		}
	}
	return "", false
}

func codexSessionProject(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	for i := 0; i < 80; i++ {
		line, err := reader.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			if cwd := cwdFromCodexLine(line); cwd != "" {
				return filepath.Base(normalizedWorkspacePath(cwd))
			}
		}
		if err != nil {
			return ""
		}
	}
	return ""
}

func cwdFromCodexLine(line []byte) string {
	var ev struct {
		CWD     string `json:"cwd"`
		Payload struct {
			CWD string `json:"cwd"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(line, &ev); err != nil {
		return ""
	}
	if strings.TrimSpace(ev.CWD) != "" {
		return strings.TrimSpace(ev.CWD)
	}
	return strings.TrimSpace(ev.Payload.CWD)
}

func sessionTitleFromJSONL(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	for i := 0; i < 160; i++ {
		line, err := reader.ReadBytes('\n')
		trimmed := strings.TrimSpace(string(line))
		if trimmed != "" {
			if title := titleFromJSONLine([]byte(trimmed)); title != "" {
				return truncateTitle(title)
			}
		}
		if err != nil {
			return ""
		}
	}
	return ""
}

func titleFromJSONLine(line []byte) string {
	var ev struct {
		Type    string          `json:"type"`
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		Payload struct {
			Type    string          `json:"type"`
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
			Text    string          `json:"text"`
			Message string          `json:"message"`
			Summary json.RawMessage `json:"summary"`
		} `json:"payload"`
		Summary json.RawMessage `json:"summary"`
	}
	if err := json.Unmarshal(line, &ev); err != nil {
		return ""
	}
	if ev.Message.Role == "user" || ev.Type == "user" {
		if title := titleFromRawContent(ev.Message.Content); title != "" {
			return title
		}
	}
	if ev.Role == "user" || ev.Payload.Role == "user" || ev.Payload.Type == "user_message" || ev.Payload.Type == "message" {
		if title := firstNonEmptyTitle(
			ev.Payload.Text,
			ev.Payload.Message,
			titleFromRawContent(ev.Payload.Content),
			titleFromRawContent(ev.Content),
		); title != "" {
			return title
		}
	}
	return firstNonEmptyTitle(titleFromRawContent(ev.Summary), titleFromRawContent(ev.Payload.Summary))
}

func titleFromRawContent(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strings.TrimSpace(s)
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		for _, item := range arr {
			if title := titleFromRawContent(item); title != "" {
				return title
			}
		}
		return ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err == nil {
		if rawType, ok := obj["type"]; ok {
			var typ string
			_ = json.Unmarshal(rawType, &typ)
			if typ == "tool_result" || typ == "tool_use" {
				return ""
			}
		}
		for _, key := range []string{"text", "message", "input", "content", "summary"} {
			if child, ok := obj[key]; ok {
				if title := titleFromRawContent(child); title != "" {
					return title
				}
			}
		}
	}
	return ""
}

func firstNonEmptyTitle(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func truncateTitle(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len([]rune(value)) <= 96 {
		return value
	}
	runes := []rune(value)
	return string(runes[:96]) + "..."
}

func normalizedWorkspacePrefix(path string) string {
	clean := normalizedWorkspacePath(path)
	if clean == "" {
		return ""
	}
	return strings.TrimSuffix(clean, string(os.PathSeparator)) + string(os.PathSeparator)
}

func normalizedWorkspacePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	return filepath.Clean(path)
}

func projectNameFromWorkspaceRoot(workspaceRoot string) string {
	clean := normalizedWorkspacePath(workspaceRoot)
	if clean == "" {
		return ""
	}
	return filepath.Base(clean)
}

func projectBasenameFromEncodedCwd(dir string) string {
	trimmed := strings.TrimPrefix(dir, "-")
	if trimmed == "" {
		return dir
	}
	parts := strings.Split(trimmed, "-")
	if len(parts) == 0 {
		return dir
	}
	last := parts[len(parts)-1]
	if last == "" {
		return dir
	}
	return last
}

func sortAndCap(entries *[]transport.SessionEntry) {
	sort.Slice(*entries, func(i, j int) bool {
		return (*entries)[i].ModTime > (*entries)[j].ModTime
	})
	if len(*entries) > MaxSessionsPerSource {
		*entries = (*entries)[:MaxSessionsPerSource]
	}
}
