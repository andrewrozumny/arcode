import { describe, expect, it } from 'vitest';
import { resolveKey, SHIFT_ENTER_SEQUENCE } from './keys';
import type { KeyInfo } from './keys';

const key = (overrides: Partial<KeyInfo>): KeyInfo => ({
  type: 'keydown',
  key: 'a',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...overrides,
});

describe('resolveKey', () => {
  it('maps Shift+Enter to the newline sequence and swallows the rest of the stroke', () => {
    expect(resolveKey(key({ key: 'Enter', shiftKey: true }), false)).toEqual({
      kind: 'send',
      data: SHIFT_ENTER_SEQUENCE,
    });
    expect(resolveKey(key({ type: 'keypress', key: 'Enter', shiftKey: true }), false)).toEqual({
      kind: 'swallow',
    });
  });

  it('maps Option+Enter to ESC CR', () => {
    expect(resolveKey(key({ key: 'Enter', altKey: true }), false)).toEqual({ kind: 'send', data: '\x1b\r' });
  });

  it('leaves plain Enter to xterm', () => {
    expect(resolveKey(key({ key: 'Enter' }), false)).toEqual({ kind: 'default' });
  });

  it('never swallows Escape', () => {
    expect(resolveKey(key({ key: 'Escape' }), false)).toEqual({ kind: 'default' });
    expect(resolveKey(key({ key: 'Escape', shiftKey: true }), false)).toEqual({ kind: 'default' });
  });

  it('maps Ctrl+Escape to a new Claude tab', () => {
    expect(resolveKey(key({ key: 'Escape', ctrlKey: true }), false)).toEqual({
      kind: 'command',
      command: 'newClaude',
    });
  });

  it('copies with Cmd+C when there is a selection, sends ^C otherwise', () => {
    expect(resolveKey(key({ key: 'c', metaKey: true }), true)).toEqual({ kind: 'copy' });
    expect(resolveKey(key({ key: 'c', metaKey: true }), false)).toEqual({ kind: 'send', data: '\x03' });
  });

  it('pastes with Cmd+V and clears with Cmd+K', () => {
    expect(resolveKey(key({ key: 'v', metaKey: true }), false)).toEqual({ kind: 'paste' });
    expect(resolveKey(key({ key: 'k', metaKey: true }), false)).toEqual({ kind: 'clear' });
  });

  it('maps tab and pane shortcuts to commands', () => {
    const cmd = (overrides: Partial<KeyInfo>) => resolveKey(key({ metaKey: true, ...overrides }), false);
    expect(cmd({ key: 't' })).toEqual({ kind: 'command', command: 'newShell' });
    expect(cmd({ key: 'w' })).toEqual({ kind: 'command', command: 'closeTab' });
    expect(cmd({ key: 'f' })).toEqual({ kind: 'command', command: 'find' });
    expect(cmd({ key: '}', shiftKey: true })).toEqual({ kind: 'command', command: 'nextTab' });
    expect(cmd({ key: '[', shiftKey: true })).toEqual({ kind: 'command', command: 'prevTab' });
    expect(cmd({ key: 'Enter', shiftKey: true })).toEqual({ kind: 'command', command: 'toggleComposer' });
  });

  it('maps font size shortcuts', () => {
    const cmd = (overrides: Partial<KeyInfo>) => resolveKey(key({ metaKey: true, ...overrides }), false);
    expect(cmd({ key: '=' })).toEqual({ kind: 'command', command: 'fontLarger' });
    expect(cmd({ key: '+', shiftKey: true })).toEqual({ kind: 'command', command: 'fontLarger' });
    expect(cmd({ key: '-' })).toEqual({ kind: 'command', command: 'fontSmaller' });
    expect(cmd({ key: '0' })).toEqual({ kind: 'command', command: 'fontReset' });
  });

  it('swallows command key-up events so nothing fires twice', () => {
    expect(resolveKey(key({ type: 'keyup', key: 't', metaKey: true }), false)).toEqual({ kind: 'swallow' });
  });

  it('keeps other Cmd shortcuts away from the shell', () => {
    expect(resolveKey(key({ key: 'p', metaKey: true }), false)).toEqual({ kind: 'swallow' });
  });

  it('does not touch Ctrl+C', () => {
    expect(resolveKey(key({ key: 'c', ctrlKey: true }), false)).toEqual({ kind: 'default' });
  });
});
