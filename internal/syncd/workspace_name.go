package syncd

import (
	"fmt"
	"path/filepath"
	"strings"
)

func (s *Service) resolveWorkspaceNameLocked(workspaceRoot string) string {
	cleaned := filepath.Clean(strings.TrimSpace(workspaceRoot))
	if existing, ok := s.workspaceNameByRoot[cleaned]; ok {
		return existing
	}
	base := filepath.Base(cleaned)
	base = sanitizeWorkspaceName(base)
	if base == "" {
		base = "workspace"
	}
	if _, exists := s.workspaceNameInUse[base]; !exists {
		s.workspaceNameByRoot[cleaned] = base
		s.workspaceNameInUse[base] = struct{}{}
		return base
	}
	dateSuffix := s.now().Format("20060102")
	candidate := fmt.Sprintf("%s-%s", base, dateSuffix)
	if _, exists := s.workspaceNameInUse[candidate]; !exists {
		s.workspaceNameByRoot[cleaned] = candidate
		s.workspaceNameInUse[candidate] = struct{}{}
		return candidate
	}
	for i := 2; ; i++ {
		candidate = fmt.Sprintf("%s-%s-%d", base, dateSuffix, i)
		if _, exists := s.workspaceNameInUse[candidate]; !exists {
			s.workspaceNameByRoot[cleaned] = candidate
			s.workspaceNameInUse[candidate] = struct{}{}
			return candidate
		}
	}
}

func sanitizeWorkspaceName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.TrimLeft(name, ".")
	name = strings.ReplaceAll(name, "..", "-")
	name = strings.ReplaceAll(name, "/", "-")
	name = strings.ReplaceAll(name, "\\", "-")
	return strings.TrimSpace(name)
}
