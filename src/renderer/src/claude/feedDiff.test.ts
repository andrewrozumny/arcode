import { describe, expect, it } from 'vitest';
import { addedRows, diffLines, diffStats, patchRows, withContext } from './feedDiff';

const marks = (rows: ReturnType<typeof diffLines>): string[] =>
  rows.map((row) => `${row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}${row.text}`);

describe('diffLines', () => {
  it('keeps common lines and puts removals before additions', () => {
    expect(marks(diffLines('a\nb\nc\n', 'a\nB\nc\n'))).toEqual([' a', '-b', '+B', ' c']);
  });

  it('finds inserted and deleted lines in the middle', () => {
    expect(marks(diffLines('one\ntwo\nthree\nfour', 'one\nthree\nfour\nfive'))).toEqual([' one', '-two', ' three', ' four', '+five']);
  });

  it('handles empty sides', () => {
    expect(marks(diffLines('', 'x\ny'))).toEqual(['+x', '+y']);
    expect(marks(diffLines('x', ''))).toEqual(['-x']);
    expect(diffLines('', '')).toEqual([]);
  });

  it('counts changes', () => {
    expect(diffStats(diffLines('a\nb\nc', 'a\nc\nd\ne'))).toEqual({ added: 2, removed: 1 });
  });
});

describe('withContext', () => {
  it('keeps three lines around changes and folds the rest into gaps', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const next = [...old];
    next[1] = 'changed1';
    next[15] = 'changed15';
    const rows = withContext(diffLines(old.join('\n'), next.join('\n')));
    const text = rows.map((row) => (row.kind === 'gap' ? '…' : row.text));
    expect(text).toEqual(['l0', 'l1', 'changed1', 'l2', 'l3', 'l4', '…', 'l12', 'l13', 'l14', 'l15', 'changed15', 'l16', 'l17', 'l18']);
  });
});

describe('patchRows', () => {
  it('numbers lines from the hunk starts and separates hunks', () => {
    const rows = patchRows([
      { oldStart: 10, newStart: 10, lines: [' keep', '-old', '+new', '+more', ' tail'] },
      { oldStart: 40, newStart: 41, lines: ['-gone'] },
    ]);
    expect(rows).toEqual([
      { kind: 'context', text: 'keep', line: 10 },
      { kind: 'removed', text: 'old', line: 11 },
      { kind: 'added', text: 'new', line: 11 },
      { kind: 'added', text: 'more', line: 12 },
      { kind: 'context', text: 'tail', line: 13 },
      { kind: 'gap' },
      { kind: 'removed', text: 'gone', line: 40 },
    ]);
  });

  it('numbers a new file from 1', () => {
    expect(addedRows('a\nb\n')).toEqual([
      { kind: 'added', text: 'a', line: 1 },
      { kind: 'added', text: 'b', line: 2 },
    ]);
  });
});
