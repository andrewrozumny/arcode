import { describe, expect, it } from 'vitest';
import type { GrepFileResult, GrepResult } from '@shared/files';
import { buildRows, firstMatch, prefillFromSelection, splitPath, stepMatch, summary } from './findModel';

const file = (path: string, lines: number[]): GrepFileResult => ({
  path,
  count: lines.length,
  matches: lines.map((line) => ({ line, column: 1, text: 'x', ranges: [{ start: 0, end: 1 }] })),
});

const result = (files: GrepFileResult[], extra: Partial<GrepResult> = {}): GrepResult => ({
  files,
  totalLines: files.reduce((n, f) => n + f.matches.length, 0),
  totalCount: files.reduce((n, f) => n + f.count, 0),
  truncated: false,
  timedOut: false,
  cancelled: false,
  engine: 'git',
  ...extra,
});

describe('buildRows', () => {
  it('puts a header before each file and hides collapsed matches', () => {
    const rows = buildRows([file('a.ts', [1, 2]), file('b.ts', [3])], new Set(['a.ts']));
    expect(rows.map((r) => r.kind)).toEqual(['file', 'file', 'match']);
    expect(rows[0]).toMatchObject({ kind: 'file', collapsed: true });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('stepMatch', () => {
  const rows = buildRows([file('a.ts', [1, 2]), file('b.ts', [3])], new Set());
  // rows: file a, m1, m2, file b, m3

  it('skips file headers and stops at the ends', () => {
    expect(firstMatch(rows)).toBe(1);
    expect(stepMatch(rows, 1, 1)).toBe(2);
    expect(stepMatch(rows, 2, 1)).toBe(4);
    expect(stepMatch(rows, 4, 1)).toBe(4);
    expect(stepMatch(rows, 4, -1)).toBe(2);
    expect(stepMatch(rows, 1, -1)).toBe(1);
    expect(stepMatch(rows, -1, 1)).toBe(1);
    expect(firstMatch([])).toBe(-1);
  });
});

describe('prefillFromSelection', () => {
  it('takes a short single-line selection only', () => {
    expect(prefillFromSelection('useState')).toBe('useState');
    expect(prefillFromSelection(null)).toBeNull();
    expect(prefillFromSelection('')).toBeNull();
    expect(prefillFromSelection('   ')).toBeNull();
    expect(prefillFromSelection('a\nb')).toBeNull();
    expect(prefillFromSelection('x'.repeat(201))).toBeNull();
  });
});

describe('summary', () => {
  it('describes counts, caps, time limits and errors', () => {
    expect(summary(null, true)).toBe('Searching…');
    expect(summary(null, false)).toBe('');
    expect(summary(result([]), false)).toBe('No matches');
    expect(summary(result([file('a', [1])]), false)).toBe('1 match in 1 file');
    expect(summary(result([file('a', [1, 2]), file('b', [3])]), false)).toBe('3 matches in 2 files');
    expect(summary(result([file('a', [1])], { truncated: true }), false)).toContain('first results only');
    expect(summary(result([file('a', [1])], { timedOut: true }), false)).toContain('time limit');
    expect(summary(result([], { error: 'Invalid regular expression' }), false)).toBe('Invalid regular expression');
  });
});

describe('splitPath', () => {
  it('splits name and folder', () => {
    expect(splitPath('src/a/b.ts')).toEqual({ name: 'b.ts', dir: 'src/a' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });
});
