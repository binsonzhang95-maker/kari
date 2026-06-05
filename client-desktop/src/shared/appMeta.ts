// Single source of truth for the displayed app version: package.json.
// app.getVersion() (main process, shown in Settings → About) reads the same
// file, so the activation/login footer, the in-app footer, and About all stay
// in lockstep on every version bump — no more hand-edited drift.
import { version } from '../../package.json';

export const APP_VERSION = version;
export const APP_COPYRIGHT = '© 2016@kari';
