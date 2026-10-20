import { describe, expect, it } from 'vitest';
import { mentionLines, resolveShortcut } from './shortcuts';
import type { ShortcutKey } from './shortcuts';

const key = (code: string, mods: Partial<ShortcutKey> = {}): ShortcutKey => ({
  code,
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  ...mods,
});

describe('resolveShortcut', () => {
  it('opens file search from anywhere, the terminal included', () => {
    expect(resolveShortcut(key('KeyP'), 'terminal')).toBe('fileSearch');
    expect(resolveShortcut(key('KeyP'), 'viewer')).toBe('fileSearch');
  });

  it('opens recent files on Cmd+Shift+E from anywhere', () => {
    const recent = key('KeyE', { shiftKey: true });
    expect(resolveShortcut(recent, 'terminal')).toBe('recentFiles');
    expect(resolveShortcut(recent, 'viewer')).toBe('recentFiles');
    expect(resolveShortcut(recent, 'tree')).toBe('recentFiles');
    expect(resolveShortcut(key('KeyE'), 'other')).toBe('toggleEdit');
  });

  it('leaves other keys in the terminal alone', () => {
    expect(resolveShortcut(key('KeyT', { shiftKey: true }), 'terminal')).toBeNull();
    expect(resolveShortcut(key('KeyS'), 'terminal')).toBeNull();
  });

  it('steps viewer tabs outside the terminal', () => {
    expect(resolveShortcut(key('BracketRight', { shiftKey: true }), 'viewer')).toBe('nextTab');
    expect(resolveShortcut(key('BracketLeft', { shiftKey: true }), 'other')).toBe('prevTab');
    expect(resolveShortcut(key('BracketRight', { shiftKey: true }), 'terminal')).toBeNull();
  });

  it('opens a Claude tab on Ctrl+Esc outside the terminal; the terminal handles its own', () => {
    const ctrlEsc = key('Escape', { metaKey: false, ctrlKey: true });
    expect(resolveShortcut(ctrlEsc, 'viewer')).toBe('newClaude');
    expect(resolveShortcut(ctrlEsc, 'other')).toBe('newClaude');
    expect(resolveShortcut(ctrlEsc, 'terminal')).toBeNull();
    expect(resolveShortcut(key('Escape', { metaKey: false }), 'viewer')).toBeNull();
  });

  it('mentions only with focus in the viewer', () => {
    expect(resolveShortcut(key('KeyK', { altKey: true }), 'viewer')).toBe('atMention');
    expect(resolveShortcut(key('KeyK', { altKey: true }), 'tree')).toBeNull();
  });

  it('saves and toggles edit outside the viewer, not inside (the viewer handles those)', () => {
    expect(resolveShortcut(key('KeyS'), 'tree')).toBe('save');
    expect(resolveShortcut(key('KeyE'), 'other')).toBe('toggleEdit');
    expect(resolveShortcut(key('KeyS'), 'viewer')).toBeNull();
  });

  it('ignores keys without Cmd', () => {
    expect(resolveShortcut(key('KeyP', { metaKey: false }), 'other')).toBeNull();
  });
});

describe('mentionLines', () => {
  const pos = (line: number, character: number) => ({ line, character });

  it('is null for an empty selection', () => {
    expect(mentionLines({ start: pos(3, 4), end: pos(3, 4) })).toBeNull();
  });

  it('covers the selected lines, zero-based and inclusive', () => {
    expect(mentionLines({ start: pos(2, 1), end: pos(5, 3) })).toEqual({ lineStart: 2, lineEnd: 5 });
    expect(mentionLines({ start: pos(5, 3), end: pos(2, 1) })).toEqual({ lineStart: 2, lineEnd: 5 });
  });

  it('drops a trailing line selected only up to its first column', () => {
    expect(mentionLines({ start: pos(2, 0), end: pos(4, 0) })).toEqual({ lineStart: 2, lineEnd: 3 });
  });
});
