// Bundle Monaco locally so the editor doesn't fall back to
// @monaco-editor/loader's default jsdelivr CDN, which is blocked /
// unreliable in some regions (notably mainland China). Symptom of
// the unfixed default: TextEditor pane stuck on "Loading…" forever,
// with `cdn.jsdelivr.net/.../min/vs/loader.js
// net::ERR_CONNECTION_CLOSED` in the renderer devtools.
//
// Vite's built-in `?worker` suffix handles the worker files: each
// import compiles to a separate chunk that Monaco spawns at runtime
// via `new Worker(url, { type: 'module' })`. No vite-plugin-monaco
// needed.
//
// Workers we ship:
//   - editorWorker  — base / generic editor worker (catch-all)
//   - jsonWorker    — language=json
//   - cssWorker     — language ∈ {css, scss, less}
//   - htmlWorker    — language ∈ {html, handlebars, razor}
//   - tsWorker      — language ∈ {javascript, typescript}
//
// Languages outside these (go, python, rust, …) still get syntax
// highlighting from Monaco's monarch tokenizer in the main thread
// without needing a dedicated worker.
//
// This module MUST be imported before any TextEditor renders, hence
// the side-effect import at the top of main.tsx.

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Point @monaco-editor/react's loader at our bundled monaco. Skips
// the AMD-style remote loader.js fetch entirely.
loader.config({ monaco });
