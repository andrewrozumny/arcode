import { describe, expect, it } from 'vitest';
import { rankPaths } from './index';
import { fuzzyMatch, positionsToRanges } from './fuzzy';

const paths = [
  'src/application/foo.ts',
  'src/renderer/src/App.tsx',
  'src/renderer/src/AppShell.tsx',
  'docs/approach.md',
  'src/main/files/service.ts',
  'src/main/files/serviceWorker.ts',
  'README.md',
  'src/shared/files.ts',
  'scripts/gates.sh',
  'package.json',
];

describe('rankPaths', () => {
  it('prefers exact file name over directory matches', () => {
    const r = rankPaths(paths, 'app');
    expect(r[0]?.path).toBe('src/renderer/src/App.tsx');
    expect(r.slice(0, 3).map((x) => x.path)).toContain('src/renderer/src/AppShell.tsx');
    expect(r[r.length - 1]?.path).toBe('src/application/foo.ts');
  });
  it('weights file name over path', () => {
    const r = rankPaths(paths, 'service');
    expect(r[0]?.path).toBe('src/main/files/service.ts');
  });
  it('matches by word initials and camel case', () => {
    expect(rankPaths(paths, 'as')[0]?.path).toBe('src/renderer/src/AppShell.tsx');
  });
  it('matches across directories when file name does not match', () => {
    const r = rankPaths(paths, 'srcsh');
    expect(r.map((x) => x.path)).toContain('src/shared/files.ts');
  });
  it('is case-insensitive and returns nothing for no match', () => {
    expect(rankPaths(paths, 'READme')[0]?.path).toBe('README.md');
    expect(rankPaths(paths, 'zzzz')).toEqual([]);
  });
  it('honors the limit and highlights contiguous ranges', () => {
    expect(rankPaths(paths, 's', 2)).toHaveLength(2);
    const [hit] = rankPaths(paths, 'gates');
    expect(hit?.path).toBe('scripts/gates.sh');
    expect(hit?.ranges).toEqual([{ start: 8, end: 13 }]);
  });
});

describe('fuzzyMatch', () => {
  it('prefers consecutive matches and word starts', () => {
    const a = fuzzyMatch('file-tree.ts', 'ft');
    const b = fuzzyMatch('soft.ts', 'ft');
    expect(a && b && a.score > b.score).toBe(true);
  });
  it('merges positions into ranges', () => {
    expect(positionsToRanges([0, 1, 2, 5, 7, 8])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
      { start: 7, end: 9 },
    ]);
  });
});
