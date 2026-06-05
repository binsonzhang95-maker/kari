import React from 'react';
import ReactDOM from 'react-dom/client';
// Side-effect import: must run before any TextEditor mounts so the
// loader is pointed at our bundled monaco. See monaco-bootstrap.ts
// for the rationale (CDN blocked in some regions).
import './monaco-bootstrap';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

