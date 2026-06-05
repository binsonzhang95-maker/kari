'use strict';

function toggleWindowZoom(win, platform = process.platform) {
  if (!win) return { fullscreen: false, maximized: false };

  if (platform === 'darwin') {
    const fullscreen = !win.isFullScreen();
    win.setFullScreen(fullscreen);
    return { fullscreen, maximized: Boolean(win.isMaximized && win.isMaximized()) };
  }

  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
  return { fullscreen: Boolean(win.isFullScreen && win.isFullScreen()), maximized: win.isMaximized() };
}

module.exports = {
  toggleWindowZoom,
};
