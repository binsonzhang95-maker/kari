export const BRACKETED_PASTE_BEGIN: string;
export const BRACKETED_PASTE_END: string;

export interface TerminalPastePlanInput {
  hasImage?: boolean;
  imageResponse?: unknown;
  text?: string;
  preferText?: boolean;
}

export interface TerminalPastePlan {
  kind: 'image' | 'text' | 'empty';
  data: string;
}

export function bracketedPaste(value: string): string;
export function clipboardImageLocalPath(response: unknown): string;
export function terminalTextPasteData(text: string, options?: { bracketMultiline?: boolean }): string;
export function terminalPastePlan(input: TerminalPastePlanInput): TerminalPastePlan;
