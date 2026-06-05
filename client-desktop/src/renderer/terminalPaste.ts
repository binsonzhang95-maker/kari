import type { Terminal } from '@xterm/xterm';
import { terminalPastePlan, terminalTextPasteData } from '../shared/terminal_paste_core.mjs';
import { isWindowsTerminalRenderer } from './terminalOptions';

interface TerminalPasteOptions {
  event: ClipboardEvent;
  terminal: Terminal;
  terminalId?: string;
}

type TerminalIdRef = string | undefined | (() => string | undefined);
const windowsRightClickCopyInstalled = new WeakSet<Terminal>();

export async function handleTerminalPaste({ event, terminal, terminalId }: TerminalPasteOptions) {
  const eventText = event.clipboardData?.getData('text/plain') || '';
  event.preventDefault();
  event.stopPropagation();
  await pasteTerminalClipboard({ terminal, terminalId, eventText });
}

export async function pasteTerminalClipboard({
  terminal,
  terminalId,
  eventText = '',
}: {
  terminal: Terminal;
  terminalId?: string;
  eventText?: string;
}) {
  const fallbackText = eventText || safeClipboardText();
  const hasImage = !fallbackText && safeClipboardHasImage();

  if (!hasImage && !fallbackText) return;

  // Prefer the direct-upload bypass — POSTs PNG bytes straight to
  // ConsoleZ, returns a server-side absolute path, and skips the
  // syncthing UpAck round-trip the legacy /v1/pty-attach path waited
  // on. The handler falls back to the local-temp path internally
  // when activation/server context is missing OR when an older
  // ConsoleZ returns 404, so callers don't need to branch here.
  const imageResponse = hasImage
    ? await (window.kari.clipboardPasteImage?.() ?? window.kari.clipboardImage()).catch(() => null)
    : null;
  const plan = terminalPastePlan({ hasImage, imageResponse, text: fallbackText, preferText: Boolean(fallbackText) });

  if (plan.kind === 'image') {
    if (terminalId) await window.kari.writeTerminal(terminalId, plan.data);
    return;
  }
  if (plan.kind === 'text') {
    pasteText(terminal, terminalId, plan.data);
  }
}

export function installWindowsTerminalPasteShortcuts(terminal: Terminal, terminalId: TerminalIdRef) {
  if (!isWindowsTerminalRenderer()) return;
  installWindowsRightClickCopy(terminal);
  terminal.attachCustomKeyEventHandler((event) => {
    if (isPasteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      void pasteTerminalClipboard({ terminal, terminalId: resolveTerminalId(terminalId) });
      return false;
    }
    if (isCopyShortcut(event) && terminal.hasSelection()) {
      event.preventDefault();
      event.stopPropagation();
      void copyText(terminal.getSelection());
      return false;
    }
    return true;
  });
}

function installWindowsRightClickCopy(terminal: Terminal, attempt = 0) {
  if (windowsRightClickCopyInstalled.has(terminal)) return;
  const element = terminal.element;
  if (!element) {
    if (attempt < 10) window.setTimeout(() => installWindowsRightClickCopy(terminal, attempt + 1), 50);
    return;
  }
  windowsRightClickCopyInstalled.add(terminal);

  let suppressNextContextMenu = false;
  const copySelectionFromMouse = (event: MouseEvent) => {
    if (!terminal.hasSelection()) return false;
    const selection = terminal.getSelection();
    if (!selection) return false;
    event.preventDefault();
    event.stopPropagation();
    suppressNextContextMenu = true;
    void copyText(selection);
    return true;
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 2) return;
    copySelectionFromMouse(event);
  };
  const onContextMenu = (event: MouseEvent) => {
    if (suppressNextContextMenu) {
      suppressNextContextMenu = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    copySelectionFromMouse(event);
  };
  element.addEventListener('mousedown', onMouseDown, true);
  element.addEventListener('contextmenu', onContextMenu, true);
  const terminalDispose = (terminal as Terminal & { onDispose?: (listener: () => void) => { dispose(): void } }).onDispose;
  terminalDispose?.(() => {
    element.removeEventListener('mousedown', onMouseDown, true);
    element.removeEventListener('contextmenu', onContextMenu, true);
  });
}

function safeClipboardHasImage() {
  try {
    return Boolean(window.kari.clipboardHasImage?.());
  } catch {
    return false;
  }
}

function safeClipboardText() {
  try {
    return window.kari.clipboardText?.() || '';
  } catch {
    return '';
  }
}

function pasteText(terminal: Terminal, terminalId: string | undefined, text: string) {
  if (terminalId && isWindowsTerminalRenderer()) {
    void window.kari.writeTerminal(terminalId, prepareTextForPty(text));
    return;
  }
  const maybePaste = (terminal as Terminal & { paste?: (data: string) => void }).paste;
  if (typeof maybePaste === 'function') {
    maybePaste.call(terminal, text);
    return;
  }
  if (terminalId) void window.kari.writeTerminal(terminalId, text);
}

function prepareTextForPty(text: string) {
  return terminalTextPasteData(text, { bracketMultiline: true });
}

function resolveTerminalId(terminalId: TerminalIdRef) {
  return typeof terminalId === 'function' ? terminalId() : terminalId;
}

function isPasteShortcut(event: KeyboardEvent) {
  if (event.type !== 'keydown' || event.altKey || event.metaKey) return false;
  const key = event.key.toLowerCase();
  return (event.ctrlKey && key === 'v') || (event.shiftKey && key === 'insert');
}

function isCopyShortcut(event: KeyboardEvent) {
  if (event.type !== 'keydown' || event.altKey || event.metaKey) return false;
  return event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c';
}

async function copyText(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard?.writeText(text);
  } catch {}
}
