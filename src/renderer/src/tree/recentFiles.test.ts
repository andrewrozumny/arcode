import { describe, expect, it } from 'vitest';
import { matchRanges, recentResults, withRecentFirst } from './recentFiles';

describe('matchRanges', () => {
  it('matches a subsequence case-insensitively, preferring the file name', () => {
    expect(matchRanges('src/App.tsx', '')).toEqual([]);
    expect(matchRanges('src/App.tsx', 'app')).toEqual([{ start: 4, end: 7 }]);
    expect(matchRanges('src/App.tsx', 'at')).toEqual([
      { start: 4, end: 5 },
      { start: 8, end: 9 },
    ]);
    // Not in the name alone: falls back to the whole path.
    expect(matchRanges('src/App.tsx', 'sapp')).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 7 },
    ]);
    expect(matchRanges('src/App.tsx', 'xyz')).toBeNull();
  });
});

describe('recentResults', () => {
  const recent = ['src/b.ts', 'src/a.ts', 'README.md'];

  it('keeps most-recent-first order and leaves out the current file', () => {
    expect(recentResults(recent, '', 'src/b.ts').map((r) => r.path)).toEqual(['src/a.ts', 'README.md']);
    expect(recentResults(recent, '', null).map((r) => r.path)).toEqual(recent);
  });

  it('filters by the query', () => {
    expect(recentResults(recent, 'read', null).map((r) => r.path)).toEqual(['README.md']);
    expect(recentResults(recent, 'ts', null).map((r) => r.path)).toEqual(['src/b.ts', 'src/a.ts']);
  });
});

describe('withRecentFirst', () => {
  it('puts recent files first and removes them from the rest', () => {
    const recent = recentResults(['b', 'a'], '', null);
    const found = ['a', 'c', 'b', 'd'].map((path) => ({ path, score: 0, ranges: [] }));
    expect(withRecentFirst(recent, found).map((r) => r.path)).toEqual(['b', 'a', 'c', 'd']);
  });
});
