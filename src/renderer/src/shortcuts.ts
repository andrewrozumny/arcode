/**
 * Window-level shortcuts for the tree, file search, Find in files and viewer. Kept free of DOM types so
 * the decision table is unit-testable; App.tsx feeds it keydown events (capture phase).
 *
 * Cmd+W and Cmd+T are not here: they come from the menu and are routed by focus in App.tsx
 * (inside the terminal the pane handles them, and Cmd+Shift+]/[, before the menu sees them).
 * Cmd+S and Cmd+E inside the viewer are handled by the viewer itself.
 */

export type FocusZone = 'terminal' | 'viewer' | 'tree' | 'other';

export type ShortcutAction =
  | 'fileSearch'
  | 'findInFiles'
  | 'recentFiles'
  | 'reopenTab'
  | 'save'
  | 'toggleEdit'
  | 'nextTab'
  | 'prevTab'
  | 'atMention'
  | 'newClaude';

export interface ShortcutKey {
  /** KeyboardEvent.code, layout independent ("KeyP", "BracketRight"). */
  code: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

export function resolveShortcut(key: ShortcutKey, zone: FocusZone): ShortcutAction | null {
  // Ctrl+Esc opens a Claude tab from anywhere; inside the terminal the pane handles it itself.
  if (key.code === 'Escape' && key.ctrlKey && !key.metaKey && !key.shiftKey && !key.altKey) {
    return zone === 'terminal' ? null : 'newClaude';
  }
  if (!key.metaKey || key.ctrlKey) return null;
  const { code, shiftKey: shift, altKey: alt } = key;

  // Anywhere, including the terminal.
  if (code === 'KeyP' && !shift && !alt) return 'fileSearch';
  if (code === 'KeyF' && shift && !alt) return 'findInFiles';
  // Cmd+E is edit mode here, so Recent Files (JetBrains Cmd+E) takes Cmd+Shift+E.
  if (code === 'KeyE' && shift && !alt) return 'recentFiles';

  if (zone === 'terminal') return null;

  if (code === 'KeyT' && shift && !alt) return 'reopenTab';
  // Outside the terminal tab stepping belongs to the viewer. Focus often falls back to
  // the page body after a tab switch (a hidden editor loses it), so do not require it.
  if (code === 'BracketRight' && shift && !alt) return 'nextTab';
  if (code === 'BracketLeft' && shift && !alt) return 'prevTab';

  if (zone === 'viewer') return code === 'KeyK' && alt && !shift ? 'atMention' : null;

  // Outside the viewer the viewer's own Cmd+S / Cmd+E handler does not see the key.
  if (code === 'KeyS' && !shift && !alt) return 'save';
  if (code === 'KeyE' && !shift && !alt) return 'toggleEdit';
  return null;
}

/** Zero-based inclusive line range of a selection; null when it is empty. */
export function mentionLines(selection: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): { lineStart: number; lineEnd: number } | null {
  const { start, end } = selection;
  if (start.line === end.line && start.character === end.character) return null;
  const lineStart = Math.min(start.line, end.line);
  let lineEnd = Math.max(start.line, end.line);
  // A selection that ends at the start of a line does not include that line.
  const last = start.line > end.line ? start : end;
  if (lineEnd > lineStart && last.character === 0) lineEnd -= 1;
  return { lineStart, lineEnd };
}
