export function droppedFilePath(file, resolvePath) {
  if (!file) return '';
  if (typeof resolvePath === 'function') {
    try {
      const resolved = String(resolvePath(file) || '').trim();
      if (resolved) return resolved;
    } catch {
      // Fall through to the pre-Electron-32 File.path augmentation.
    }
  }
  if (typeof file === 'object' && typeof file.path === 'string') {
    return file.path.trim();
  }
  return '';
}

export function droppedFilePaths(files, resolvePath) {
  return Array.from(files || [])
    .map((file) => droppedFilePath(file, resolvePath))
    .filter(Boolean);
}
