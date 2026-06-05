import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react';
import { endInternalFileDrag, getInternalDragPath } from '../internalFileDrag';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Plus, Square, TerminalSquare, X } from 'lucide-react';
import type { TerminalCreateResult, TerminalKind, TerminalMode } from '../../shared/types';
import { useI18n } from '../i18n';
import { handleTerminalPaste, installWindowsTerminalPasteShortcuts } from '../terminalPaste';
import { createTerminalOptions, stabilizeWindowsTerminalCursor } from '../terminalOptions';

interface TerminalDockProps {
  request: { kind: TerminalKind; mode: TerminalMode; nonce: number } | null;
  defaultMode: TerminalMode;
}

interface TerminalTab extends TerminalCreateResult {
  exited?: boolean;
}

interface TerminalHandle {
  terminal: Terminal;
  fit: FitAddon;
}

export function TerminalDock({ request, defaultMode }: TerminalDockProps) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState('');
  const [mode, setMode] = useState<TerminalMode>(defaultMode);
  const handles = useRef(new Map<string, TerminalHandle>());
  const containers = useRef(new Map<string, HTMLDivElement>());
  const handledRequest = useRef(0);

  const attach = useCallback((id: string, node: HTMLDivElement | null) => {
    if (!node) {
      containers.current.delete(id);
      return;
    }
    containers.current.set(id, node);
    const handle = handles.current.get(id);
    if (handle && !node.hasChildNodes()) {
      handle.terminal.open(node);
      handle.fit.fit();
    }
  }, []);

  const create = useCallback(async (kind: TerminalKind, selectedMode: TerminalMode) => {
    const cols = 120;
    const rows = 28;
    const result = await window.kari.createTerminal({ kind, mode: selectedMode, cols, rows });
    const terminal = new Terminal(createTerminalOptions({
      fontSize: 13,
      theme: {
        background: '#080b10',
        foreground: '#d3dde7',
        cursor: '#f0bd72',
        selectionBackground: '#26425f',
        black: '#10141b',
        red: '#ff6b6b',
        green: '#59d69d',
        yellow: '#e7b566',
        blue: '#70b7ff',
        magenta: '#d58cff',
        cyan: '#55d6d2',
        white: '#d3dde7',
        brightBlack: '#596170',
        brightRed: '#ff8787',
        brightGreen: '#76f0b8',
        brightYellow: '#ffd38a',
        brightBlue: '#95c9ff',
        brightMagenta: '#e2adff',
        brightCyan: '#80eee9',
        brightWhite: '#ffffff'
      },
    }));
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.onData((data) => void window.kari.writeTerminal(result.id, data));
    terminal.onResize(({ cols, rows }) => {
      void window.kari.resizeTerminal(result.id, cols, rows);
    });
    handles.current.set(result.id, { terminal, fit });
    setTabs((prev) => [...prev, result]);
    setActiveId(result.id);
    window.setTimeout(() => {
      const container = containers.current.get(result.id);
      if (container && !container.hasChildNodes()) {
        terminal.open(container);
        stabilizeWindowsTerminalCursor(terminal);
        installWindowsTerminalPasteShortcuts(terminal, result.id);
        fit.fit();
      }
    }, 0);
  }, []);

  useEffect(() => {
    if (!request || request.nonce === handledRequest.current) return;
    handledRequest.current = request.nonce;
    void create(request.kind, request.mode);
  }, [create, request]);

  useEffect(() => {
    const offData = window.kari.onTerminalData(({ id, data }) => {
      handles.current.get(id)?.terminal.write(data);
    });
    const offExit = window.kari.onTerminalExit(({ id, code }) => {
      handles.current.get(id)?.terminal.writeln(`\r\n[process exited: ${code ?? 'signal'}]`);
      setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, exited: true } : tab)));
    });
    return () => {
      offData();
      offExit();
    };
  }, []);

  const fitActiveTerminal = useCallback(() => {
    const handle = handles.current.get(activeId);
    if (!handle) return;
    try {
      handle.fit.fit();
    } catch {
      return;
    }
  }, [activeId]);

  useEffect(() => {
    const fitTimers = new Set<number>();
    let fitRaf = 0;
    const clearQueuedFits = () => {
      if (fitRaf) {
        window.cancelAnimationFrame(fitRaf);
        fitRaf = 0;
      }
      for (const timer of fitTimers) window.clearTimeout(timer);
      fitTimers.clear();
    };
    const scheduleFit = () => {
      clearQueuedFits();
      fitRaf = window.requestAnimationFrame(() => {
        fitRaf = 0;
        fitActiveTerminal();
      });
      for (const delay of [80, 220, 500]) {
        const timer = window.setTimeout(() => {
          fitTimers.delete(timer);
          fitActiveTerminal();
        }, delay);
        fitTimers.add(timer);
      }
    };
    const container = activeId ? containers.current.get(activeId) : null;
    const observer = new ResizeObserver(scheduleFit);
    if (container) observer.observe(container);
    observer.observe(document.documentElement);
    window.addEventListener('resize', scheduleFit);
    window.visualViewport?.addEventListener('resize', scheduleFit);
    scheduleFit();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      window.visualViewport?.removeEventListener('resize', scheduleFit);
      clearQueuedFits();
    };
  }, [activeId, fitActiveTerminal]);

  const stop = async (id: string) => {
    await window.kari.stopTerminal(id);
    handles.current.get(id)?.terminal.dispose();
    handles.current.delete(id);
    setTabs((prev) => prev.filter((tab) => tab.id !== id));
    if (activeId === id) setActiveId((tabs.find((tab) => tab.id !== id) || tabs[0])?.id || '');
  };

  const active = tabs.find((tab) => tab.id === activeId);
  const pasteIntoTab = useCallback((id: string, event: ReactClipboardEvent<HTMLDivElement>) => {
    const handle = handles.current.get(id);
    if (!handle) return;
    void handleTerminalPaste({ event: event.nativeEvent, terminal: handle.terminal, terminalId: id });
  }, []);
  // File-tree → terminal drop. Internal drags only — Finder/external
  // drops are silently ignored (no preventDefault, so the browser's
  // default "drop = navigate" behavior keeps any out-of-app intent
  // from being mistakenly captured here).
  const acceptInternalFileDrag = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!getInternalDragPath()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);
  const dropInternalFileIntoTab = useCallback((id: string, event: ReactDragEvent<HTMLDivElement>) => {
    const dragPath = getInternalDragPath();
    if (!dragPath) return;
    event.preventDefault();
    endInternalFileDrag();
    if (!handles.current.has(id)) return;
    void window.kari.writeTerminal(id, dragPath);
  }, []);

  return (
    <aside className="terminal-dock">
      <div className="terminal-toolbar">
        <div className="terminal-title"><TerminalSquare size={16} /> CLI Dock</div>
        <div className="terminal-controls">
          <select value={mode} onChange={(event) => setMode(event.target.value as TerminalMode)}>
            <option value="remote">remote</option>
            <option value="local">local</option>
          </select>
          <button onClick={() => void create('shell', mode)} title={t('terminal.newShell')}><Plus size={15} /> Shell</button>
          <button onClick={() => void create('codex', mode)} title={t('terminal.newCodex')}>Codex</button>
          <button onClick={() => void create('claude', mode)} title={t('terminal.newClaude')}>Claude</button>
          <button onClick={() => void create('opencode', 'local')} title={t('terminal.newOpenCode')}>OpenCode</button>
          <button onClick={() => void create('shell', 'remote')} title={t('terminal.newRemoteShell')}>Remote Shell</button>
        </div>
      </div>
      <div className="terminal-tabs">
        {tabs.length === 0 && <span className="terminal-empty">no cli session</span>}
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={tab.id === activeId ? 'terminal-tab terminal-tab--active' : 'terminal-tab'}
            onClick={() => setActiveId(tab.id)}
          >
            <span className={tab.exited ? 'tab-dot tab-dot--dead' : 'tab-dot'} />
            {tab.title}
            <X size={13} onClick={(event) => { event.stopPropagation(); void stop(tab.id); }} />
          </button>
        ))}
      </div>
      <div className="terminal-body">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeId ? 'terminal-pane terminal-pane--active' : 'terminal-pane'}
            onPasteCapture={(event) => pasteIntoTab(tab.id, event)}
            onDragOver={(event) => acceptInternalFileDrag(event)}
            onDrop={(event) => dropInternalFileIntoTab(tab.id, event)}
            ref={(node) => attach(tab.id, node)}
          />
        ))}
        {tabs.length === 0 && (
          <div className="terminal-placeholder">
            <TerminalSquare size={30} />
            <span>{t('terminal.placeholder')}</span>
          </div>
        )}
      </div>
      <div className="terminal-footer">
        <span>{active ? `${active.mode}/${active.kind}` : 'idle'}</span>
        <div>
          <button className="icon-btn" disabled={!active} onClick={() => active && void stop(active.id)} title={t('terminal.stop')}><Square size={15} /></button>
        </div>
      </div>
    </aside>
  );
}
