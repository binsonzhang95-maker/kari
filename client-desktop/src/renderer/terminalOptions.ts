import type { IDisposable, ITerminalOptions, ITheme, Terminal } from '@xterm/xterm';

const TERMINAL_FONT_FAMILY = 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';
const windowsCursorGuardedTerminals = new WeakSet<Terminal>();

function windowsBuildNumber() {
  const release = window.kari.platformInfo?.osRelease || '';
  const match = release.match(/^\d+\.\d+\.(\d+)/);
  if (!match) return undefined;
  const buildNumber = Number(match[1]);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

export function isWindowsTerminalRenderer() {
  if (window.kari.platformInfo?.platform === 'win32') return true;
  if (typeof navigator === 'undefined') return false;
  return /^Win/i.test(navigator.platform || '');
}

export function createTerminalOptions({
  fontSize = 13,
  theme,
}: {
  fontSize?: number;
  theme: ITheme;
}): ITerminalOptions {
  const isWindows = isWindowsTerminalRenderer();
  const options: ITerminalOptions = {
    cursorBlink: !isWindows,
    cursorInactiveStyle: isWindows ? 'block' : 'outline',
    cursorStyle: 'block',
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize,
    scrollback: 10000,
    scrollOnUserInput: true,
    scrollSensitivity: isWindows ? 0.85 : 1,
    fastScrollSensitivity: isWindows ? 4 : 5,
    smoothScrollDuration: isWindows ? 80 : 0,
    theme,
  };

  if (isWindows) {
    const buildNumber = windowsBuildNumber();
    options.windowsPty = {
      backend: 'conpty',
      ...(buildNumber ? { buildNumber } : {}),
    };
  }

  return options;
}

export function stabilizeWindowsTerminalCursor(terminal: Terminal): IDisposable | undefined {
  if (!isWindowsTerminalRenderer()) return undefined;
  if (windowsCursorGuardedTerminals.has(terminal)) return undefined;
  windowsCursorGuardedTerminals.add(terminal);
  terminal.options.cursorBlink = false;
  terminal.options.cursorInactiveStyle = 'block';
  terminal.options.cursorStyle = 'block';
  const hideCursorGuard = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    return isCursorVisibilityOnlyParam(params, 25);
  });
  terminal.write('\x1b[?25h');
  return hideCursorGuard;
}

function isCursorVisibilityOnlyParam(params: (number | number[])[], value: number) {
  return params.length === 1 && paramContains(params[0], value);
}

function paramContains(param: number | number[], value: number) {
  return Array.isArray(param) ? param.includes(value) : param === value;
}
