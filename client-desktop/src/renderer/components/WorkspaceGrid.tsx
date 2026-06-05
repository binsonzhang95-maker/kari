import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { endInternalFileDrag, getInternalDragPath } from '../internalFileDrag';
import Editor from '@monaco-editor/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { ExternalLink, Maximize2, Move, PanelTopClose, Plus, Save, Square, TerminalSquare, Undo2, X } from 'lucide-react';
import type { ReadFileResult, TerminalCreateResult, TerminalKind, TerminalMode } from '../../shared/types';
import { useI18n } from '../i18n';
import { handleTerminalPaste, installWindowsTerminalPasteShortcuts } from '../terminalPaste';
import { createTerminalOptions, stabilizeWindowsTerminalCursor } from '../terminalOptions';

export type WorkspacePane =
  | {
      id: string;
      type: 'cli';
      title: string;
      kind: TerminalKind;
      mode: TerminalMode;
      terminalId?: string;
      exited?: boolean;
      error?: string;
      floating?: boolean;
      shakeNonce?: number;
      resumeSessionId?: string;
    }
  | {
      id: string;
      type: 'editor';
      title: string;
      file: ReadFileResult;
      content: string;
      savedContent: string;
      dirty: boolean;
      saving?: boolean;
    };

interface WorkspaceGridProps {
  panes: WorkspacePane[];
  activePaneId: string;
  onActivePane: (id: string) => void;
  onClosePane: (id: string) => void;
  onNewTerminal: (kind: TerminalKind, mode?: TerminalMode, resumeSessionId?: string) => void;
  onCliStarted: (paneId: string, result: TerminalCreateResult) => void;
  onCliExited: (paneId: string) => void;
  onCliError: (paneId: string, error: string) => void;
  onCliActivity: () => void;
  onRenamePane: (paneId: string, title: string) => void;
  onTogglePaneFloating: (paneId: string, floating: boolean) => void;
  onShakeFloatingPane: (paneId: string) => void;
  onEditorChange: (paneId: string, content: string) => void;
  onEditorSave: (paneId: string) => void;
  onConfirmCloseDirtyEditor: (title: string) => Promise<boolean>;
}

interface TerminalHandle {
  terminal: Terminal;
  fit: FitAddon;
  terminalId?: string;
}

interface EditorHandle {
  editor: any;
  monaco: any;
  decorations: string[];
}

interface LineChange {
  type: 'added' | 'modified' | 'deleted';
  lineNumber: number;
  count?: number;
}

export function WorkspaceGrid({
  panes,
  activePaneId,
  onActivePane,
  onClosePane,
  onNewTerminal,
  onCliStarted,
  onCliExited,
  onCliError,
  onCliActivity,
  onRenamePane,
  onTogglePaneFloating,
  onShakeFloatingPane,
  onEditorChange,
  onEditorSave,
  onConfirmCloseDirtyEditor
}: WorkspaceGridProps) {
  const { t } = useI18n();
  const [focusPaneId, setFocusPaneId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<{ paneId: string; value: string } | null>(null);
  const [shakingPanes, setShakingPanes] = useState<Set<string>>(new Set());
  const handles = useRef(new Map<string, TerminalHandle>());
  const editorHandles = useRef(new Map<string, EditorHandle>());
  const containers = useRef(new Map<string, HTMLDivElement>());
  const paneResizeObservers = useRef(new Map<string, ResizeObserver>());
  const paneFitTimers = useRef(new Map<string, number>());
  const terminalToPane = useRef(new Map<string, string>());
  const starting = useRef(new Set<string>());
  const detachedTerminals = useRef(new Map<string, string>());
  const shakeSeen = useRef(new Map<string, number>());
  const panesRef = useRef(panes);
  const mirroredTerminalResize = useRef(new Set<string>());
  const terminalAttentionBuffers = useRef(new Map<string, string>());
  const terminalAttentionLastAt = useRef(new Map<string, number>());
  const shakeTimers = useRef(new Map<string, number>());
  const activePaneIdRef = useRef(activePaneId);

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    if (focusPaneId && !panes.some((pane) => pane.id === focusPaneId)) {
      setFocusPaneId(null);
    }
  }, [focusPaneId, panes]);

  useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId]);

  const paneHasUserFocus = useCallback((paneId: string) => {
    if (!document.hasFocus()) return false;
    if (activePaneIdRef.current === paneId) return true;
    const activeElement = document.activeElement;
    const terminalHost = containers.current.get(paneId);
    return !!(activeElement && terminalHost && terminalHost.contains(activeElement));
  }, []);

  const activatePane = useCallback((paneId: string) => {
    activePaneIdRef.current = paneId;
    onActivePane(paneId);
  }, [onActivePane]);

  const focusTerminalPane = useCallback((paneId: string) => {
    const handle = handles.current.get(paneId);
    const host = containers.current.get(paneId);
    if (!handle || !host || !host.offsetParent) return;
    try {
      handle.terminal.focus();
    } catch {
      // xterm can throw while its DOM is being reparented.
    }
  }, []);

  const requestTerminalFocus = useCallback((paneId: string) => {
    requestAnimationFrame(() => focusTerminalPane(paneId));
  }, [focusTerminalPane]);

  const launchTerminal = useCallback((event: ReactMouseEvent<HTMLButtonElement>, kind: TerminalKind, mode: TerminalMode) => {
    event.currentTarget.blur();
    onNewTerminal(kind, mode);
  }, [onNewTerminal]);

  const attach = useCallback((paneId: string, node: HTMLDivElement | null) => {
    if (!node) {
      containers.current.delete(paneId);
      const obs = paneResizeObservers.current.get(paneId);
      if (obs) {
        obs.disconnect();
        paneResizeObservers.current.delete(paneId);
      }
      const timer = paneFitTimers.current.get(paneId);
      if (timer) {
        window.clearTimeout(timer);
        paneFitTimers.current.delete(paneId);
      }
      return;
    }
    containers.current.set(paneId, node);
    const handle = handles.current.get(paneId);
    if (handle && !node.hasChildNodes()) {
      const element = (handle.terminal as unknown as { element?: HTMLElement }).element;
      if (element) node.appendChild(element);
      else {
        handle.terminal.open(node);
        stabilizeWindowsTerminalCursor(handle.terminal);
      }
      // First fit after the next animation frame lets the browser settle
      // layout (when terminal.open just created the xterm sub-tree the host
      // can briefly report 0×0). Without this xterm sticks at its default
      // 80×24 even though the pane is full-screen.
      requestAnimationFrame(() => fitTerminal(paneId, handle));
      if (activePaneIdRef.current === paneId) requestTerminalFocus(paneId);
    }
    // Re-fit on every container resize. The pane-grid template changes
    // dimensions whenever panes are added/removed/focused, and the window
    // resize handler only catches OS-level resizes — that misses every
    // intra-app layout shuffle. Debounced so that the burst of size
    // notifications React emits during mount / pane-grid rejig collapses
    // into a single refit instead of N back-to-back IPC roundtrips.
    if (!paneResizeObservers.current.has(paneId)) {
      const obs = new ResizeObserver(() => {
        const previous = paneFitTimers.current.get(paneId);
        if (previous) window.clearTimeout(previous);
        paneFitTimers.current.set(paneId, window.setTimeout(() => {
          paneFitTimers.current.delete(paneId);
          const h = handles.current.get(paneId);
          if (h) fitTerminal(paneId, h);
        }, 80));
      });
      obs.observe(node);
      paneResizeObservers.current.set(paneId, obs);
    }
  }, [requestTerminalFocus]);

  useEffect(() => {
    const pane = panes.find((item) => item.id === activePaneId);
    if (pane?.type !== 'cli' || pane.floating || editingTitle?.paneId === activePaneId) return;
    requestTerminalFocus(activePaneId);
  }, [activePaneId, editingTitle?.paneId, panes, requestTerminalFocus]);

  const triggerPaneAttention = useCallback((paneId: string, force = false, ignoreLocalFocus = false) => {
    const now = Date.now();
    const last = terminalAttentionLastAt.current.get(paneId) || 0;
    if (!force && now - last < 8000) return;
    terminalAttentionLastAt.current.set(paneId, now);
    const pane = panesRef.current.find((item) => item.id === paneId);
    if (!ignoreLocalFocus && paneHasUserFocus(paneId)) return;
    if (pane?.type === 'cli' && pane.floating && pane.terminalId) {
      void window.kari.focusDetachedTerminal(pane.terminalId);
      return;
    }
    setShakingPanes((prev) => {
      const next = new Set(prev);
      next.add(paneId);
      return next;
    });
    const previous = shakeTimers.current.get(paneId);
    if (previous) window.clearTimeout(previous);
    shakeTimers.current.set(paneId, window.setTimeout(() => {
      setShakingPanes((prev) => {
        const next = new Set(prev);
        next.delete(paneId);
        return next;
      });
      shakeTimers.current.delete(paneId);
    }, 680));
  }, [paneHasUserFocus]);

  const inspectTerminalAttention = useCallback((paneId: string, data: string) => {
    const pane = panesRef.current.find((item) => item.id === paneId);
    if (pane?.type !== 'cli' || (pane.kind !== 'codex' && pane.kind !== 'claude')) return;
    const cleaned = normalizeTerminalOutput(data);
    if (!cleaned.trim()) return;
    const next = `${terminalAttentionBuffers.current.get(paneId) || ''}${cleaned}`.slice(-4000);
    terminalAttentionBuffers.current.set(paneId, next);
    if (terminalNeedsUser(next)) triggerPaneAttention(paneId);
  }, [triggerPaneAttention]);

  const attachEditor = useCallback((paneId: string, editor: any, monaco: any) => {
    const handle = { editor, monaco, decorations: [] };
    editorHandles.current.set(paneId, handle);
    const pane = panes.find((item) => item.id === paneId);
    if (pane?.type === 'editor') applyEditorDecorations(pane, handle);
  }, [panes]);

  useEffect(() => {
    const offData = window.kari.onTerminalData(({ id, data }) => {
      const paneId = terminalToPane.current.get(id);
      if (paneId) {
        handles.current.get(paneId)?.terminal.write(data);
        const pane = panesRef.current.find((item) => item.id === paneId);
        inspectTerminalAttention(paneId, data);
        if (pane?.type === 'cli' && (pane.kind === 'codex' || pane.kind === 'claude')) {
          onCliActivity();
        }
      }
    });
    const offExit = window.kari.onTerminalExit(({ id, code }) => {
      const paneId = terminalToPane.current.get(id);
      if (!paneId) return;
      handles.current.get(paneId)?.terminal.writeln(`\r\n[process exited: ${code ?? 'signal'}]`);
      onCliExited(paneId);
      triggerPaneAttention(paneId, true);
    });
    return () => {
      offData();
      offExit();
    };
  }, [inspectTerminalAttention, onCliActivity, onCliExited, triggerPaneAttention]);

  useEffect(() => {
    const offResize = window.kari.onTerminalResize(({ id, cols, rows }) => {
      const paneId = terminalToPane.current.get(id);
      if (!paneId) return;
      const pane = panesRef.current.find((item) => item.id === paneId);
      if (pane?.type !== 'cli' || !pane.floating) return;
      const handle = handles.current.get(paneId);
      if (!handle) return;
      if (handle.terminal.cols === cols && handle.terminal.rows === rows) return;
      mirroredTerminalResize.current.add(paneId);
      try {
        handle.terminal.resize(cols, rows);
      } catch {
        // The hidden xterm can be between DOM detach/reattach phases.
      } finally {
        window.setTimeout(() => mirroredTerminalResize.current.delete(paneId), 0);
      }
    });
    return offResize;
  }, []);

  useEffect(() => {
    return () => {
      for (const [paneId, handle] of handles.current) {
        if (handle.terminalId) {
          void window.kari.stopTerminal(handle.terminalId);
          terminalToPane.current.delete(handle.terminalId);
        }
        handle.terminal.dispose();
        terminalAttentionBuffers.current.delete(paneId);
        terminalAttentionLastAt.current.delete(paneId);
      }
      handles.current.clear();
      detachedTerminals.current.clear();
      for (const timer of shakeTimers.current.values()) {
        window.clearTimeout(timer);
      }
      shakeTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    for (const pane of panes) {
      if (pane.type !== 'cli') continue;
      if (pane.terminalId || handles.current.has(pane.id) || starting.current.has(pane.id) || pane.error) continue;
      starting.current.add(pane.id);
      void startTerminalPane(pane)
        .catch((err) => onCliError(pane.id, String(err instanceof Error ? err.message : err)))
        .finally(() => starting.current.delete(pane.id));
    }
  }, [onCliError, panes]);

  useEffect(() => {
    const livePaneIds = new Set(panes.map((pane) => pane.id));
    for (const [paneId, handle] of handles.current) {
      if (livePaneIds.has(paneId)) continue;
      if (handle.terminalId) {
        void window.kari.stopTerminal(handle.terminalId);
        terminalToPane.current.delete(handle.terminalId);
        terminalAttentionBuffers.current.delete(paneId);
        terminalAttentionLastAt.current.delete(paneId);
      }
      handle.terminal.dispose();
      handles.current.delete(paneId);
    }
    for (const paneId of [...editorHandles.current.keys()]) {
      if (!livePaneIds.has(paneId)) editorHandles.current.delete(paneId);
    }
    for (const paneId of [...shakeTimers.current.keys()]) {
      if (livePaneIds.has(paneId)) continue;
      const timer = shakeTimers.current.get(paneId);
      if (timer) window.clearTimeout(timer);
      shakeTimers.current.delete(paneId);
    }
  }, [panes]);

  useEffect(() => {
    for (const pane of panes) {
      if (pane.type !== 'editor') continue;
      const handle = editorHandles.current.get(pane.id);
      if (handle) applyEditorDecorations(pane, handle);
    }
  }, [panes]);

  useEffect(() => {
    const fitAll = () => {
      for (const [paneId, handle] of handles.current) fitTerminal(paneId, handle);
    };
    window.addEventListener('resize', fitAll);
    const timer = window.setTimeout(fitAll, 80);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', fitAll);
    };
  }, [panes.length, focusPaneId]);

  useEffect(() => {
    for (const pane of panes) {
      if (pane.type !== 'cli') continue;
      if (pane.floating && pane.terminalId) {
        const previousTitle = detachedTerminals.current.get(pane.terminalId);
        if (previousTitle !== pane.title) {
          detachedTerminals.current.set(pane.terminalId, pane.title);
          void window.kari.detachTerminal(pane.terminalId, pane.title);
        }
      } else if (pane.terminalId && detachedTerminals.current.has(pane.terminalId)) {
        detachedTerminals.current.delete(pane.terminalId);
        void window.kari.closeDetachedTerminal(pane.terminalId);
        // Re-dock: while floated, the detached window resized the PTY to its
        // own width. If the grid xterm already has the right cols/rows, fit()
        // will not emit onResize, so explicitly sync the visible pane size.
        // Without that, Windows ConPTY can stay at the detached-window width
        // while the grid renders full width.
        const restoredPaneId = pane.id;
        const forceRefit = () => {
          const h = handles.current.get(restoredPaneId);
          if (!h) return;
          const resized = fitTerminal(restoredPaneId, h);
          if (!resized) syncTerminalSizeToPty(restoredPaneId, h);
        };
        requestAnimationFrame(forceRefit);
        // Belt-and-suspenders: the detached window can emit one last resize as
        // it closes, landing AFTER the rAF fit and re-pinning ConPTY at the
        // detached width. A delayed forced refit guarantees the grid width is
        // the last size pushed to the PTY.
        window.setTimeout(forceRefit, 400);
      }
      if (!pane.floating || !pane.terminalId || !pane.shakeNonce) continue;
      const previous = shakeSeen.current.get(pane.id) || 0;
      if (previous === pane.shakeNonce) continue;
      shakeSeen.current.set(pane.id, pane.shakeNonce);
      triggerPaneAttention(pane.id, true, true);
    }
  }, [panes, triggerPaneAttention]);

  useEffect(() => {
    const offClosed = window.kari.onTerminalDetachedClosed(({ id }) => {
      detachedTerminals.current.delete(id);
      const pane = panes.find((item) => item.type === 'cli' && item.terminalId === id);
      if (pane) onTogglePaneFloating(pane.id, false);
    });
    return offClosed;
  }, [onTogglePaneFloating, panes]);

  const startTerminalPane = async (pane: Extract<WorkspacePane, { type: 'cli' }>) => {
    const terminal = new Terminal(createTerminalOptions({
      fontSize: panes.length >= 6 ? 12 : 13,
      theme: {
        background: '#070604',
        foreground: '#d8c6a3',
        cursor: '#c89a4b',
        selectionBackground: '#3b2b17',
        black: '#0b0906',
        red: '#b46353',
        green: '#9b8f60',
        yellow: '#b58b46',
        blue: '#8a7656',
        magenta: '#9b7351',
        cyan: '#a58c5f',
        white: '#d8c6a3',
        brightBlack: '#5a4a32',
        brightRed: '#d08a6f',
        brightGreen: '#c1b278',
        brightYellow: '#d1a85c',
        brightBlue: '#bca06c',
        brightMagenta: '#c28f67',
        brightCyan: '#c7a96f',
        brightWhite: '#f0dfbd'
      },
    }));
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.onData((data) => {
      const handle = handles.current.get(pane.id);
      if (handle?.terminalId) void window.kari.writeTerminal(handle.terminalId, data);
    });
    terminal.onResize(({ cols, rows }) => {
      const handle = handles.current.get(pane.id);
      if (!handle?.terminalId) return;
      if (mirroredTerminalResize.current.has(pane.id)) return;
      void window.kari.resizeTerminal(handle.terminalId, cols, rows);
    });
    handles.current.set(pane.id, { terminal, fit });
    const container = containers.current.get(pane.id);
    if (container && !container.hasChildNodes()) {
      terminal.open(container);
      stabilizeWindowsTerminalCursor(terminal);
      requestAnimationFrame(() => fitTerminal(pane.id, { terminal, fit }));
      requestTerminalFocus(pane.id);
    }
    const spawnCols = terminal.cols || 100;
    const spawnRows = terminal.rows || 28;
    const result = await window.kari.createTerminal({ kind: pane.kind, mode: pane.mode, cols: spawnCols, rows: spawnRows, resumeSessionId: pane.resumeSessionId });
    const currentHandle = { terminal, fit, terminalId: result.id };
    handles.current.set(pane.id, currentHandle);
    installWindowsTerminalPasteShortcuts(terminal, () => handles.current.get(pane.id)?.terminalId);
    terminalToPane.current.set(result.id, pane.id);
    onCliStarted(pane.id, result);
    if (terminal.cols !== spawnCols || terminal.rows !== spawnRows) {
      syncTerminalSizeToPty(pane.id, currentHandle);
    }
    // One more fit after we've told the host process the size — the very
    // first attach may have run before grid layout settled, and the IPC
    // round-trip gave the browser time to paint the final dimensions.
    requestAnimationFrame(() => {
      fitTerminal(pane.id, { terminal, fit, terminalId: result.id });
      focusTerminalPane(pane.id);
    });
    // Belt-and-suspenders refit ~500ms after creation. Windows Chromium's
    // initial grid layout settles in several reflows; the rAF fit above can
    // read .pane-terminal-host's intermediate height and tell xterm to use
    // half the eventual row count. Local TUI panes (codex/claude) repaint
    // aggressively and mask this; a Remote Shell pane is plain bash with no
    // redraws, so the wrong row count sticks visually. Dimension guard makes
    // this a no-op when the rAF fit was already correct.
    window.setTimeout(() => {
      const h = handles.current.get(pane.id);
      if (h) fitTerminal(pane.id, h);
    }, 500);
  };

  const fitTerminal = (paneId: string, handle: TerminalHandle) => {
    const container = containers.current.get(paneId);
    if (!container || !container.offsetParent) return false;
    const beforeCols = handle.terminal.cols;
    const beforeRows = handle.terminal.rows;
    try {
      handle.fit.fit();
      return handle.terminal.cols !== beforeCols || handle.terminal.rows !== beforeRows;
    } catch {
      // xterm-fit can throw before fonts/layout are ready.
      return false;
    }
  };

  const syncTerminalSizeToPty = (paneId: string, handle: TerminalHandle) => {
    if (!handle.terminalId) return;
    const container = containers.current.get(paneId);
    if (!container || !container.offsetParent) return;
    void window.kari.resizeTerminal(handle.terminalId, handle.terminal.cols, handle.terminal.rows);
  };

  const pasteIntoPane = useCallback((paneId: string, event: ReactClipboardEvent<HTMLDivElement>) => {
    const handle = handles.current.get(paneId);
    if (!handle) return;
    void handleTerminalPaste({ event: event.nativeEvent, terminal: handle.terminal, terminalId: handle.terminalId });
  }, []);

  // File-tree → PTY drop. Only honors drags that originated in the
  // file tree (internalFileDrag side-channel); Finder/external drops
  // are ignored so the existing "drop folder to import" affordance
  // on the welcome page stays the only OS-level entry point.
  const acceptInternalFileDrag = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!getInternalDragPath()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);
  const dropInternalFileIntoPane = useCallback((paneId: string, event: ReactDragEvent<HTMLDivElement>) => {
    const dragPath = getInternalDragPath();
    if (!dragPath) return;
    event.preventDefault();
    endInternalFileDrag();
    const handle = handles.current.get(paneId);
    if (!handle || !handle.terminalId) return;
    // User asked for the simplest possible UX: just type the absolute
    // path into the terminal as plain text. No bracketed paste, no
    // shell-quoting, no trailing space — whatever the user wants to
    // do with the path next is up to them.
    void window.kari.writeTerminal(handle.terminalId, dragPath);
  }, []);

  function applyEditorDecorations(pane: Extract<WorkspacePane, { type: 'editor' }>, handle: EditorHandle) {
    const changes = computeLineChanges(pane.file.baseContent, pane.content, pane.file.baseKind);
    const decorations = changes.map((change) => {
      const line = Math.max(1, change.lineNumber);
      const label = change.type === 'added'
        ? t('workspace.addedLine')
        : change.type === 'modified'
          ? t('workspace.modifiedLine')
          : t('workspace.deletedLines', { count: change.count || 1 });
      const color = change.type === 'added' ? '#8fbf68' : change.type === 'modified' ? '#d1a85c' : '#b46353';
      return {
        range: new handle.monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: change.type !== 'deleted',
          className: change.type === 'added' ? 'git-line-added-bg' : change.type === 'modified' ? 'git-line-modified-bg' : '',
          glyphMarginClassName: `git-line-${change.type}-glyph`,
          overviewRuler: {
            color,
            position: handle.monaco.editor.OverviewRulerLane.Left
          },
          minimap: {
            color,
            position: handle.monaco.editor.MinimapPosition.Inline
          },
          hoverMessage: { value: label }
        }
      };
    });
    handle.decorations = handle.editor.deltaDecorations(handle.decorations, decorations);
  }

  const stopPane = (pane: WorkspacePane) => {
    if (pane.type !== 'cli' || !pane.terminalId) return;
    void window.kari.stopTerminal(pane.terminalId).then((result) => {
      if (result.stopped) onCliExited(pane.id);
    });
  };

  const closePane = async (pane: WorkspacePane) => {
    if (pane.type === 'editor' && pane.dirty) {
      const confirmed = await onConfirmCloseDirtyEditor(pane.title);
      if (!confirmed) return;
    }
    onClosePane(pane.id);
  };

  const commitTitleEdit = () => {
    if (!editingTitle) return;
    onRenamePane(editingTitle.paneId, editingTitle.value);
    setEditingTitle(null);
  };

  const renderPaneTitle = (pane: WorkspacePane) => {
    if (editingTitle?.paneId === pane.id) {
      return (
        <input
          className="pane-title-input"
          value={editingTitle.value}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onChange={(event) => setEditingTitle({ paneId: pane.id, value: event.currentTarget.value })}
          onBlur={commitTitleEdit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitTitleEdit();
            if (event.key === 'Escape') setEditingTitle(null);
          }}
        />
      );
    }
    return (
      <strong
        className="pane-title"
        title={t('workspace.renameTitle', { title: pane.title })}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setEditingTitle({ paneId: pane.id, value: pane.title });
        }}
      >
        {pane.title}
      </strong>
    );
  };

  const visiblePanes = focusPaneId ? panes.filter((pane) => pane.id === focusPaneId) : panes;
  const isFocusMode = Boolean(focusPaneId);

  return (
    <main className={isFocusMode ? 'pane-workspace pane-workspace--focus' : 'pane-workspace'}>
      {!isFocusMode && (
        <div className="pane-toolbar">
          <div>
            <span className="eyebrow">MULTI PANE WORKSPACE</span>
            <h1>{`${panes.length}/9 panes`}</h1>
          </div>
          <div className="pane-toolbar__actions">
            <button className="ghost-btn" onClick={(event) => launchTerminal(event, 'shell', 'local')} disabled={panes.length >= 9}><Plus size={14} /> Local Shell</button>
            <button className="ghost-btn" onClick={(event) => launchTerminal(event, 'codex', 'remote')} disabled={panes.length >= 9}>Remote Codex</button>
            <button className="ghost-btn" onClick={(event) => launchTerminal(event, 'claude', 'remote')} disabled={panes.length >= 9}>Remote Claude</button>
            <button className="ghost-btn" onClick={(event) => launchTerminal(event, 'shell', 'remote')} disabled={panes.length >= 9}>Remote Shell</button>
          </div>
        </div>
      )}
      <section className={`pane-grid pane-grid--${visiblePanes.length || 1} ${focusPaneId ? 'pane-grid--focus' : ''}`}>
        {visiblePanes.length === 0 && (
          <div className="empty-pane-grid">
            <TerminalSquare size={34} />
            <strong>{t('workspace.emptyTitle')}</strong>
            <span>{t('workspace.emptyDesc')}</span>
          </div>
        )}
        {visiblePanes.map((pane, index) => (
          <article
            key={pane.id}
            className={[
              'workspace-pane',
              pane.id === activePaneId ? 'workspace-pane--active' : '',
              pane.type === 'cli' && pane.floating ? 'workspace-pane--floating-slot' : '',
              shakingPanes.has(pane.id) ? 'workspace-pane--shake' : ''
            ].filter(Boolean).join(' ')}
            data-slot={index + 1}
            onMouseDown={() => activatePane(pane.id)}
          >
            <div className="workspace-pane__head">
              <span className={pane.type === 'cli' ? 'pane-kind pane-kind--cli' : 'pane-kind pane-kind--editor'}>
                {pane.type === 'cli' ? 'CLI' : 'TXT'}
              </span>
              {renderPaneTitle(pane)}
              {pane.type === 'editor' && pane.file.gitBadge && (
                <span className={`git-badge git-badge--${pane.file.gitBadge.toLowerCase()}`} title={`Git ${pane.file.gitStatus || pane.file.gitBadge}`}>
                  {pane.file.gitBadge}
                </span>
              )}
              <div className="workspace-pane__actions">
                {isFocusMode ? (
                  <button className="icon-btn workspace-pane__focus-exit" onClick={() => setFocusPaneId(null)} title={t('workspace.exitFocus')}>
                    <PanelTopClose size={14} />
                  </button>
                ) : (
                  <>
                    {pane.type === 'editor' && (
                      <button className="icon-btn" onClick={() => onEditorSave(pane.id)} disabled={!pane.dirty || pane.saving} title={t('workspace.saveSync')}>
                        <Save size={14} />
                      </button>
                    )}
                    {pane.type === 'cli' && (
                      <>
                        {pane.floating ? (
                          <>
                            <button className="icon-btn" onClick={() => onTogglePaneFloating(pane.id, false)} title={t('workspace.restoreFloat')}><Undo2 size={14} /></button>
                            <button className="icon-btn" onClick={() => onShakeFloatingPane(pane.id)} title={t('workspace.shakeFloat')}><Move size={14} /></button>
                          </>
                        ) : (
                          <>
                            <button className="icon-btn" onClick={() => stopPane(pane)} title={t('workspace.stop')}><Square size={14} /></button>
                            <button className="icon-btn" onClick={() => onTogglePaneFloating(pane.id, true)} title={t('workspace.detach')}><ExternalLink size={14} /></button>
                          </>
                        )}
                      </>
                    )}
                    {!(pane.type === 'cli' && pane.floating) && (
                      <button className="icon-btn" onClick={() => setFocusPaneId(pane.id)} title="Focus">
                        <Maximize2 size={14} />
                      </button>
                    )}
                    <button className="icon-btn" onClick={() => closePane(pane)} title={t('workspace.close')}><X size={14} /></button>
                  </>
                )}
              </div>
            </div>
            {pane.type === 'cli' && pane.floating ? (
              <div className="floating-slot-body">
                <TerminalSquare size={28} />
                <strong>{t('workspace.floatingTitle')}</strong>
                <span>{t('workspace.floatingDesc')}</span>
                <div>
                  <button className="icon-btn" onClick={() => onTogglePaneFloating(pane.id, false)} title={t('workspace.restore')}><Undo2 size={15} /></button>
                  <button className="icon-btn" onClick={() => onShakeFloatingPane(pane.id)} title={t('workspace.locate')}><Move size={15} /></button>
                </div>
              </div>
            ) : pane.type === 'cli' ? (
              <div className="workspace-pane__terminal">
                {pane.error ? <div className="pane-error">{pane.error}</div> : null}
                <div
                  className="pane-terminal-host"
                  onPasteCapture={(event) => pasteIntoPane(pane.id, event)}
                  onDragOver={(event) => acceptInternalFileDrag(event)}
                  onDrop={(event) => dropInternalFileIntoPane(pane.id, event)}
                  ref={(node) => attach(pane.id, node)}
                />
                {pane.exited && <div className="pane-exit-badge">exited</div>}
              </div>
            ) : (
              <div className="workspace-pane__editor">
                <Editor
                  path={pane.file.path}
                  value={pane.content}
                  language={pane.file.language}
                  theme="vs-dark"
                  onMount={(editor, monaco) => attachEditor(pane.id, editor, monaco)}
                  onChange={(value) => onEditorChange(pane.id, value || '')}
                  options={{
                    fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: panes.length >= 6 ? 12 : 13,
                    lineNumbers: 'on',
                    glyphMargin: true,
                    minimap: { enabled: false },
                    overviewRulerBorder: false,
                    scrollBeyondLastLine: false,
                    renderLineHighlight: 'all',
                    automaticLayout: true,
                    padding: { top: 12, bottom: 12 }
                  }}
                />
              </div>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}

function computeLineChanges(baseContent: string | undefined, currentContent: string, baseKind: ReadFileResult['baseKind']): LineChange[] {
  if (baseKind === 'none' || baseContent == null) return [];
  const base = splitLines(baseContent);
  const current = splitLines(currentContent);
  if (base.length === 0 && current.length === 0) return [];
  if (base.length === 0) {
    return current.map((_, index) => ({ type: 'added', lineNumber: index + 1 }));
  }
  if (base.length + current.length > 5000) {
    return coarseLineChanges(base, current);
  }
  const ops = diffLines(base, current);
  const changes: LineChange[] = [];
  let currentLine = 1;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'equal') {
      currentLine++;
      continue;
    }
    if (op.type === 'delete') {
      const deleted = collectRun(ops, i, 'delete');
      const nextIndex = i + deleted.length;
      const inserted = collectRun(ops, nextIndex, 'insert');
      const paired = Math.min(deleted.length, inserted.length);
      for (let p = 0; p < paired; p++) {
        changes.push({ type: 'modified', lineNumber: currentLine + p });
      }
      for (let p = paired; p < inserted.length; p++) {
        changes.push({ type: 'added', lineNumber: currentLine + p });
      }
      if (deleted.length > inserted.length) {
        changes.push({ type: 'deleted', lineNumber: Math.max(1, currentLine - 1), count: deleted.length - inserted.length });
      }
      currentLine += inserted.length;
      i = nextIndex + inserted.length - 1;
      continue;
    }
    changes.push({ type: 'added', lineNumber: currentLine });
    currentLine++;
  }
  return changes;
}

function splitLines(value: string) {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') return [];
  return normalized.split('\n');
}

function normalizeTerminalOutput(value: string) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ');
}

function terminalNeedsUser(buffer: string) {
  const text = buffer.toLowerCase();
  const patterns = [
    /do you want to (allow|continue|proceed|run|apply)/i,
    /\b(allow|approve|accept|confirm|permission|required approval|needs approval)\b/i,
    /\b(yes|no|deny|cancel)\b.{0,80}\b(continue|proceed|approve|allow)\b/i,
    /\b(run this command|apply these edits|accept edits|trust this project)\b/i,
    /❯\s*\d+\.|>\s*\d+\./,
    /press (enter|y|n)|\[y\/n\]|\(y\/n\)/i
  ];
  return patterns.some((pattern) => pattern.test(buffer)) ||
    (text.includes('codex') && text.includes('approval')) ||
    (text.includes('claude') && text.includes('permission'));
}

function coarseLineChanges(base: string[], current: string[]): LineChange[] {
  const limit = Math.min(base.length, current.length);
  const changes: LineChange[] = [];
  for (let i = 0; i < limit; i++) {
    if (base[i] !== current[i]) changes.push({ type: 'modified', lineNumber: i + 1 });
  }
  for (let i = limit; i < current.length; i++) {
    changes.push({ type: 'added', lineNumber: i + 1 });
  }
  if (base.length > current.length) {
    changes.push({ type: 'deleted', lineNumber: Math.max(1, current.length), count: base.length - current.length });
  }
  return changes;
}

type LineOp = { type: 'equal' | 'delete' | 'insert'; text: string };

function diffLines(base: string[], current: string[]): LineOp[] {
  const rows = base.length + 1;
  const cols = current.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = current.length - 1; j >= 0; j--) {
      dp[i][j] = base[i] === current[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < current.length) {
    if (base[i] === current[j]) {
      ops.push({ type: 'equal', text: current[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', text: base[i] });
      i++;
    } else {
      ops.push({ type: 'insert', text: current[j] });
      j++;
    }
  }
  while (i < base.length) {
    ops.push({ type: 'delete', text: base[i] });
    i++;
  }
  while (j < current.length) {
    ops.push({ type: 'insert', text: current[j] });
    j++;
  }
  return ops;
}

function collectRun(ops: LineOp[], start: number, type: LineOp['type']) {
  const out: LineOp[] = [];
  for (let i = start; i < ops.length; i++) {
    if (ops[i].type !== type) break;
    out.push(ops[i]);
  }
  return out;
}
