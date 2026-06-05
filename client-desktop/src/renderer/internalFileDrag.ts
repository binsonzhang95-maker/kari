// internalFileDrag — tiny shared state for "file tree → terminal" drag.
//
// Why a module global instead of dataTransfer.setData: when the file
// tree calls window.kari.startFileDrag(), Electron's webContents.
// startDrag takes over with an OS-level drag handle. The HTML5
// dataTransfer the renderer set up beforehand does NOT survive into
// the drop target's onDrop event — both internal-startDrag drops and
// external-Finder drops arrive with dataTransfer.files populated and
// indistinguishable from each other. Without a side-channel we can't
// honor "only accept drops that came from the file tree".
//
// This module is that side-channel. The file tree calls
// beginInternalFileDrag(path) on dragstart and endInternalFileDrag()
// on dragend; the terminal panes read getInternalDragPath() in their
// drop handlers. Same renderer process / same React tree, so the
// module-level variable is the cheapest possible coordination point.
//
// Scope: main window only. Detached terminal windows live in a
// separate renderer process and would need IPC to learn about the
// drag — out of scope for now (user opted for the simplest possible
// path).

let activePath: string | null = null;

export function beginInternalFileDrag(absPath: string): void {
  const cleaned = String(absPath || '').trim();
  activePath = cleaned || null;
}

export function endInternalFileDrag(): void {
  activePath = null;
}

export function getInternalDragPath(): string {
  return activePath ?? '';
}
