export const BRACKETED_PASTE_BEGIN = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

export function bracketedPaste(value) {
  return `${BRACKETED_PASTE_BEGIN}${String(value || '')}${BRACKETED_PASTE_END}`;
}

export function clipboardImageLocalPath(response) {
  const payload = response && typeof response === 'object' && response.data && typeof response.data === 'object'
    ? response.data
    : response;
  if (!payload || typeof payload !== 'object') return '';
  if (!payload.has_image || typeof payload.local_path !== 'string') return '';
  return payload.local_path;
}

export function terminalTextPasteData(text, options = {}) {
  const value = typeof text === 'string' ? text : String(text || '');
  const hasLineBreak = /[\r\n]/.test(value);
  const prepared = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r');
  if (options && options.bracketMultiline && hasLineBreak) {
    return bracketedPaste(prepared);
  }
  return prepared;
}

export function terminalPastePlan(input) {
  const hasImage = Boolean(input && input.hasImage);
  const text = typeof input?.text === 'string' ? input.text : String(input?.text || '');
  if (input?.preferText && text) return { kind: 'text', data: text };
  if (hasImage) {
    const localPath = clipboardImageLocalPath(input?.imageResponse);
    if (localPath) return { kind: 'image', data: bracketedPaste(localPath) };
  }
  if (text) return { kind: 'text', data: text };
  return { kind: 'empty', data: '' };
}
