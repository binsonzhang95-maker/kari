import { useEffect, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useI18n } from '../i18n';

export type WindowChromeState = {
  fullscreen: boolean;
  maximized: boolean;
  platform: NodeJS.Platform;
};

// useWindowState subscribes to main-process window-state pushes
// (enter/leave-full-screen, maximize, unmaximize). The renderer-side
// state stays in sync with the BrowserWindow so the chrome buttons +
// status-bar layout reflect reality without polling.
//
// Initial fetch fills `platform` (which the broadcast also includes
// so the listener can update it too, though it never actually changes
// after mount).
export function useWindowState(): WindowChromeState {
  const [state, setState] = useState<WindowChromeState>({
    fullscreen: false,
    maximized: false,
    platform: 'darwin',
  });
  useEffect(() => {
    let cancelled = false;
    void window.kari.windowState()
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => {});
    const off = window.kari.onWindowState((s) => setState(s));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return state;
}

export function WindowTitleBar({ children }: { children?: ReactNode }) {
  const windowState = useWindowState();
  const isMac = windowState.platform === 'darwin';
  const brand = (
    <div className="window-titlebar__brand" aria-label="Kari">
      <svg className="window-titlebar__moon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <defs>
          <linearGradient id="window-titlebar-moon-light" x1="4" y1="2" x2="14" y2="16" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff8df" />
            <stop offset=".55" stopColor="#d1a85c" />
            <stop offset="1" stopColor="#b58b46" />
          </linearGradient>
          <mask id="window-titlebar-moon-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
            <rect width="18" height="18" fill="black" />
            <circle cx="8.4" cy="9.2" r="6.4" fill="white" />
            <circle className="brand-moon__shadow" cx="11.6" cy="7.8" r="6.3" fill="black" />
          </mask>
        </defs>
        <g transform="rotate(-18 9 9)">
          <rect width="18" height="18" fill="url(#window-titlebar-moon-light)" mask="url(#window-titlebar-moon-mask)" />
        </g>
      </svg>
      <span>KARI</span>
    </div>
  );

  if (isMac) {
    return (
      <header className="window-titlebar window-titlebar--mac" data-mac-fullscreen={windowState.fullscreen ? 'true' : undefined}>
        <WindowControls state={windowState} />
        <div className="window-titlebar__content">{children}</div>
        {brand}
      </header>
    );
  }

  return (
    <header className="window-titlebar">
      {brand}
      <div className="window-titlebar__content">{children}</div>
      <WindowControls state={windowState} />
    </header>
  );
}

export function WindowControls({ state: stateProp }: { state?: WindowChromeState } = {}) {
  const { t } = useI18n();
  const ownState = useWindowState();
  const state = stateProp ?? ownState;
  const isMac = state.platform === 'darwin';
  const maximizeTitle = state.fullscreen ? t('window.exitFullscreen') : t('window.maximize');
  const MaximizeIcon = state.fullscreen ? Minimize2 : Maximize2;
  const closeBtn = (
    <button
      key="close"
      className="window-control--close"
      type="button"
      onClick={() => void window.kari.windowClose()}
      title={t('window.close')}
      aria-label={t('window.close')}
    >
      <X size={14} />
    </button>
  );
  const minimizeBtn = (
    <button
      key="minimize"
      type="button"
      onClick={() => void window.kari.windowMinimize()}
      title={t('window.minimize')}
      aria-label={t('window.minimize')}
    >
      <Minus size={14} />
    </button>
  );
  const maximizeBtn = (
    <button
      key="maximize"
      type="button"
      onClick={() => void window.kari.windowToggleMaximize()}
      title={maximizeTitle}
      aria-label={maximizeTitle}
    >
      <MaximizeIcon size={13} />
    </button>
  );
  // macOS traffic-light convention is close · minimize · maximize from
  // the leftmost edge. Non-mac (Windows/Linux) Kari keeps the canonical
  // right-side ordering of maximize · minimize · close (close-rightmost)
  // because there are no native traffic lights to mirror.
  const buttons = isMac ? [closeBtn, minimizeBtn, maximizeBtn] : [maximizeBtn, minimizeBtn, closeBtn];
  return (
    <div
      className={`window-controls${isMac ? ' window-controls--mac' : ''}`}
      aria-label={t('window.controls')}
    >
      {buttons}
    </div>
  );
}
