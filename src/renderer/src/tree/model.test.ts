import { describe, expect, it } from 'vitest';
import type { DirEntry, ExternalEntry } from '@shared/files';
import {
  DEFAULT_EXTERNAL_SORT,
  EMPTY_SELECTION,
  ancestorsOf,
  clickSelection,
  flatten,
  highlightSegments,
  isUnderAny,
  parseQuery,
  partialDeleteMessage,
  remapPath,
  nextExternalSort,
  rangeBetween,
  singleSelection,
  sortExternalEntries,
  withoutPaths,
  toRel,
  topmostPaths,
} from './model';
import type { TreeSelection } from './model';

const e = (name: string, kind: DirEntry['kind'] = 'file'): DirEntry => ({ name, kind, ignored: false, heavy: false });

describe('flatten', () => {
  it('only descends into expanded, loaded folders', () => {
    const children = new Map<string, DirEntry[]>([
      ['', [e('src', 'dir'), e('lib', 'dir'), e('a.ts')]],
      ['src', [e('b.ts'), e('deep', 'dir')]],
    ]);
    const rows = flatten(children, new Set(['src', 'lib']));
    expect(rows.map((r) => `${r.depth}:${r.rel}`)).toEqual(['0:src', '1:src/b.ts', '1:src/deep', '0:lib', '0:a.ts']);
    expect(rows[0]?.expanded).toBe(true);
  });
});

describe('path helpers', () => {
  it('converts absolute to relative paths', () => {
    expect(toRel('/p/app', '/p/app/src/a.ts')).toBe('src/a.ts');
    expect(toRel('/p/app/', '/p/app')).toBe('');
    expect(toRel('/p/app', '/p/app2/x')).toBeNull();
  });
  it('lists ancestors', () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('c.ts')).toEqual([]);
  });
  it('remaps renamed folders', () => {
    expect(remapPath('a/b/c', 'a/b', 'a/z')).toBe('a/z/c');
    expect(remapPath('a/bc', 'a/b', 'a/z')).toBe('a/bc');
  });
});

describe('parseQuery', () => {
  it('extracts the line suffix', () => {
    expect(parseQuery('App.tsx:40')).toEqual({ query: 'App.tsx', line: 40 });
    expect(parseQuery('App.tsx:40:7')).toEqual({ query: 'App.tsx', line: 40 });
    expect(parseQuery('App')).toEqual({ query: 'App' });
    expect(parseQuery('a:b')).toEqual({ query: 'a:b' });
  });
});

describe('highlightSegments', () => {
  it('clips ranges to the requested window', () => {
    const segs = highlightSegments('src/App.tsx', [{ start: 1, end: 2 }, { start: 4, end: 7 }], 4, 11);
    expect(segs).toEqual([
      { text: 'App', match: true },
      { text: '.tsx', match: false },
    ]);
  });
});

describe('sortExternalEntries', () => {
  const x = (name: string, kind: 'file' | 'dir', mtimeMs: number, size = 0): ExternalEntry => ({
    name,
    path: `/h/${name}`,
    kind,
    size,
    mtimeMs,
  });
  const entries = [x('b.txt', 'file', 2, 10), x('a.txt', 'file', 3, 5), x('zdir', 'dir', 1), x('c.txt', 'file', 3, 1)];

  it('puts newest files first and folders after them by default', () => {
    expect(sortExternalEntries(entries, DEFAULT_EXTERNAL_SORT).map((e) => e.name)).toEqual([
      'c.txt',
      'a.txt',
      'b.txt',
      'zdir',
    ]);
  });

  it('sorts by name and by size in both directions', () => {
    expect(sortExternalEntries(entries, { key: 'name', dir: 'asc' }).map((e) => e.name)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
      'zdir',
    ]);
    expect(sortExternalEntries(entries, { key: 'size', dir: 'desc' }).map((e) => e.name)).toEqual([
      'b.txt',
      'a.txt',
      'c.txt',
      'zdir',
    ]);
  });
});

describe('nextExternalSort', () => {
  it('flips direction on the same column and starts a new one sensibly', () => {
    expect(nextExternalSort({ key: 'date', dir: 'desc' }, 'date')).toEqual({ key: 'date', dir: 'asc' });
    expect(nextExternalSort({ key: 'date', dir: 'asc' }, 'date')).toEqual({ key: 'date', dir: 'desc' });
    expect(nextExternalSort({ key: 'date', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextExternalSort({ key: 'name', dir: 'asc' }, 'size')).toEqual({ key: 'size', dir: 'desc' });
  });
});

describe('tree selection', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((rel) => ({ rel }));
  const items = (sel: TreeSelection): string[] => [...sel.items].sort();
  const plain = { toggle: false, range: false };
  const cmd = { toggle: true, range: false };
  const shift = { toggle: false, range: true };
  const cmdShift = { toggle: true, range: true };

  it('takes the visible rows between two paths in either direction', () => {
    expect(rangeBetween(rows, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(rows, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(rows, null, 'c')).toEqual(['c']);
    expect(rangeBetween(rows, 'gone', 'c')).toEqual(['c']);
    expect(rangeBetween(rows, 'a', 'gone')).toEqual([]);
  });

  it('plain click selects one row and moves the anchor', () => {
    const sel = clickSelection(singleSelection('a'), rows, 'c', plain);
    expect(items(sel)).toEqual(['c']);
    expect(sel.anchor).toBe('c');
    expect(sel.focus).toBe('c');
  });

  it('Cmd+click toggles a row in and out and moves the anchor', () => {
    let sel = clickSelection(singleSelection('a'), rows, 'c', cmd);
    expect(items(sel)).toEqual(['a', 'c']);
    expect(sel.anchor).toBe('c');
    sel = clickSelection(sel, rows, 'a', cmd);
    expect(items(sel)).toEqual(['c']);
    expect(sel.focus).toBe('a');
  });

  it('Shift+click selects from the anchor and keeps it for the next Shift+click', () => {
    let sel = clickSelection(singleSelection('b'), rows, 'd', shift);
    expect(items(sel)).toEqual(['b', 'c', 'd']);
    expect(sel.anchor).toBe('b');
    sel = clickSelection(sel, rows, 'a', shift);
    expect(items(sel)).toEqual(['a', 'b']);
    expect(sel.focus).toBe('a');
  });

  it('Cmd+Shift+click adds the range to the selection', () => {
    let sel = clickSelection(singleSelection('a'), rows, 'c', cmd);
    sel = clickSelection(sel, rows, 'e', cmdShift);
    expect(items(sel)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('Shift+click without a visible anchor selects just the row', () => {
    const sel = clickSelection(EMPTY_SELECTION, rows, 'c', shift);
    expect(items(sel)).toEqual(['c']);
    expect(sel.anchor).toBe('c');
  });

  it('keeps only the topmost of nested paths', () => {
    expect(topmostPaths(['src/a.ts', 'src', 'lib/b.ts', 'src2', 'src'])).toEqual(['src', 'lib/b.ts', 'src2']);
  });
});

describe('isUnderAny', () => {
  it('matches a root itself and paths inside it, not name prefixes', () => {
    expect(isUnderAny('src', ['src'])).toBe(true);
    expect(isUnderAny('src/a.ts', ['lib', 'src'])).toBe(true);
    expect(isUnderAny('srcx/a.ts', ['src'])).toBe(false);
    expect(isUnderAny('a', [])).toBe(false);
  });
});

describe('withoutPaths', () => {
  it('drops trashed paths and their contents from the selection', () => {
    const sel = { items: new Set(['a', 'a/b', 'c', 'd']), focus: 'a/b', anchor: 'c' };
    const next = withoutPaths(sel, ['a']);
    expect([...next.items]).toEqual(['c', 'd']);
    expect(next.focus).toBeNull();
    expect(next.anchor).toBe('c');
  });

  it('returns the same selection when nothing went', () => {
    const sel = singleSelection('a');
    expect(withoutPaths(sel, [])).toBe(sel);
  });
});

describe('partialDeleteMessage', () => {
  it('names the count and the item that failed', () => {
    expect(partialDeleteMessage(2, 5, 'src/lib/x.ts', 'EACCES')).toBe('Moved 2 of 5; failed: x.ts: EACCES');
  });
});
