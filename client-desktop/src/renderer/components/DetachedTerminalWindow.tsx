import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Pin, PinOff, Square, Undo2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { handleTerminalPaste, installWindowsTerminalPasteShortcuts } from '../terminalPaste';
import { createTerminalOptions, isWindowsTerminalRenderer, stabilizeWindowsTerminalCursor } from '../terminalOptions';

const DETACHED_TERMINAL_FIT_DEBOUNCE_MS = 120;

interface TerminalHandle {
  terminal: Terminal;
  fit: FitAddon;
}

export function DetachedTerminalWindow() {
  const { t } = useI18n();
  const params = new URLSearchParams(window.location.search);
  const terminalId = params.get('detachedTerminal') || '';
  const [title, setTitle] = useState(params.get('title') || 'Terminal');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const [exited, setExited] = useState(false);
  // Pin state: in-memory in main; we sync once on mount so the toggle
  // reflects truth across re-opens of the detached window for the same
  // terminal ID. Pinned PTYs survive automatic project-exit cleanup;
  // the explicit Stop button still kills (force).
  const [pinned, setPinned] = useState(false);
  // Whether main project view currently has a pane for this terminal.
  // false = main is at project list or in a different project; clicking
  // window-close should stop the PTY instead of orphaning it.
  const [hasPane, setHasPane] = useState(true);
  const togglePin = useCallback(async () => {
    if (!terminalId) return;
    const next = !pinned;
    setPinned(next);
    try {
      await window.kari.setTerminalPinned(terminalId, next);
    } catch {
      // Roll back optimistic flip if IPC failed.
      setPinned(!next);
    }
  }, [pinned, terminalId]);

  // fit() only resizes the xterm grid to its container. terminal.onResize,
  // wired at creation, is the single path that pushes cols/rows to the PTY.
  const fit = useCallback(() => {
    try {
      handleRef.current?.fit.fit();
    } catch {
      // FitAddon throws when the host hasn't been laid out yet (0x0); the next
      // ResizeObserver callback refits once it has a real size.
    }
  }, []);
  const pasteIntoTerminal = useCallback((event: ReactClipboardEvent<HTMLElement>) => {
    const handle = handleRef.current;
    if (!handle) return;
    void handleTerminalPaste({ event: event.nativeEvent, terminal: handle.terminal, terminalId });
  }, [terminalId]);

  useEffect(() => {
    if (!terminalId || !hostRef.current || handleRef.current) return;
    const terminal = new Terminal(createTerminalOptions({
      fontSize: 13,
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
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    stabilizeWindowsTerminalCursor(terminal);
    installWindowsTerminalPasteShortcuts(terminal, terminalId);
    terminal.onData((data) => void window.kari.writeTerminal(terminalId, data));
    // Canonical xterm <-> PTY resize wiring: whenever xterm's dimensions
    // actually change (a fit, the font finishing load, etc.), push the new
    // cols/rows to the PTY. On Windows this drives ConPTY's ResizePseudoConsole;
    // firing only on real changes avoids the duplicate-resize buffer scramble
    // we used to guard against by hand.
    terminal.onResize(({ cols, rows }) => {
      void window.kari.resizeTerminal(terminalId, cols, rows);
    });
    handleRef.current = { terminal, fit: fitAddon };
    void window.kari.terminalSnapshot(terminalId).then((snapshot) => {
      if (snapshot.data) terminal.write(snapshot.data);
      if (!snapshot.alive) setExited(true);
      fit();
    });
    void window.kari.isTerminalPinned(terminalId).then((v) => setPinned(Boolean(v)));
    void window.kari.hasActiveTerminalPane(terminalId).then((v) => setHasPane(Boolean(v)));
    return () => {
      terminal.dispose();
      handleRef.current = null;
    };
  }, [fit, terminalId]);

  useEffect(() => {
    const offData = window.kari.onTerminalData(({ id, data }) => {
      if (id === terminalId) handleRef.current?.terminal.write(data);
    });
    const offExit = window.kari.onTerminalExit(({ id, code }) => {
      if (id !== terminalId) return;
      handleRef.current?.terminal.writeln(`\r\n[process exited: ${code ?? 'signal'}]`);
      setExited(true);
    });
    const offTitle = window.kari.onTerminalDetachedTitle(({ id, title: nextTitle }) => {
      if (id === terminalId && nextTitle) setTitle(nextTitle);
    });
    const offActive = window.kari.onActiveTerminalPanesChanged(({ ids }) => {
      setHasPane(ids.includes(terminalId));
    });
    // Refit after the detached window's resize burst settles. Windows ConPTY
    // can emit full-screen redraws for every ResizePseudoConsole call; fitting
    // on every drag frame lets redraws generated for size A land after xterm
    // already moved to size B. Coalescing keeps xterm and ConPTY on the final
    // size instead of replaying a storm of intermediate layouts.
    const host = hostRef.current;
    const debounceConptyFit = isWindowsTerminalRenderer();
    let fitTimer = 0;
    let fitRaf = 0;
    const scheduleFit = () => {
      if (debounceConptyFit) {
        if (fitTimer) window.clearTimeout(fitTimer);
        fitTimer = window.setTimeout(() => {
          fitTimer = 0;
          fit();
        }, DETACHED_TERMINAL_FIT_DEBOUNCE_MS);
        return;
      }
      if (fitRaf) window.cancelAnimationFrame(fitRaf);
      fitRaf = window.requestAnimationFrame(() => {
        fitRaf = 0;
        fit();
      });
    };
    const observer = host ? new ResizeObserver(scheduleFit) : null;
    if (observer && host) observer.observe(host);
    window.addEventListener('resize', scheduleFit);
    scheduleFit();
    return () => {
      offData();
      offExit();
      offTitle();
      offActive();
      observer?.disconnect();
      window.removeEventListener('resize', scheduleFit);
      if (fitTimer) window.clearTimeout(fitTimer);
      if (fitRaf) window.cancelAnimationFrame(fitRaf);
    };
  }, [fit, terminalId]);

  return (
    <main className="detached-terminal-window">
      <header className="detached-terminal-titlebar">
        <span className={exited ? 'tab-dot tab-dot--dead' : 'tab-dot'} />
        <strong title={title}>{title}</strong>
        <button
          className={pinned ? 'icon-btn icon-btn--pinned' : 'icon-btn'}
          onClick={togglePin}
          title={pinned ? t('terminal.unpin') : t('terminal.pin')}
          aria-pressed={pinned}
        >
          {pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
        <button className="icon-btn" onClick={() => terminalId && void window.kari.stopTerminal(terminalId, { force: true })} title={t('terminal.stop')}><Square size={14} /></button>
        {/* Icon + behavior depend on whether main has a pane to dock back
            to (App.tsx pushes the active terminal IDs to main).
              hasPane=true  → Undo2, windowClose(): PTY stays alive,
                              main pane re-attaches via terminal:detached-closed
              hasPane=false → X,    stopTerminal(force): no pane left,
                              so the close button means kill the PTY
                              entirely (avoids headless orphan). */}
        <button
          className="icon-btn"
          onClick={() => {
            if (hasPane) {
              void window.kari.windowClose();
            } else if (terminalId) {
              void window.kari.stopTerminal(terminalId, { force: true });
            }
          }}
          title={hasPane ? t('window.backToMain') : t('window.closeAndStop')}
          aria-label={hasPane ? t('window.backToMain') : t('window.closeAndStop')}
        >
          {hasPane ? <Undo2 size={14} /> : <X size={14} />}
        </button>
      </header>
      <section className="detached-terminal-body" onPasteCapture={pasteIntoTerminal} ref={hostRef} />
    </main>
  );
}
