import { EditorSelection, EditorState } from '@codemirror/state';
import type { Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { duplicateLineOrSelection } from './duplicate';

function run(doc: string, selection: EditorSelection, readOnly = false): EditorState | null {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)],
  });
  let next: EditorState | null = null;
  duplicateLineOrSelection({ state, dispatch: (tr: Transaction) => (next = tr.state) });
  return next;
}

describe('duplicateLineOrSelection', () => {
  it('duplicates the cursor line below and keeps the column', () => {
    const next = run('one\ntwo\nthree', EditorSelection.single(5));
    expect(next?.doc.toString()).toBe('one\ntwo\ntwo\nthree');
    expect(next?.selection.main.head).toBe(9);
  });

  it('repeats a selection after itself and selects the copy', () => {
    const next = run('let a = 1;', EditorSelection.single(4, 5));
    expect(next?.doc.toString()).toBe('let aa = 1;');
    expect([next?.selection.main.from, next?.selection.main.to]).toEqual([5, 6]);
  });

  it('handles several cursors', () => {
    const next = run('a\nb', EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]));
    expect(next?.doc.toString()).toBe('a\na\nb\nb');
  });

  it('does nothing in read-only mode', () => {
    expect(run('a', EditorSelection.single(0), true)).toBeNull();
  });
});
