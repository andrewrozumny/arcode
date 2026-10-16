import { describe, expect, it } from 'vitest';
import { findLinkMatches, lineCells } from './links';

/** Shorthand: the first candidate of every match plus its parsed line numbers. */
function summarize(line: string) {
  return findLinkMatches(line).map((m) => ({
    path: m.candidates[0]?.path,
    start: m.candidates[0]?.start,
    line: m.line,
    endLine: m.endLine,
  }));
}

/** Plain (no-space) references only, ignoring the multi-word candidates. */
function plain(line: string) {
  return summarize(line).filter((m) => !m.path?.includes(' '));
}

describe('findLinkMatches', () => {
  it('finds Read(...) tool calls and reports the path offset', () => {
    const line = '● Read(src/main/index.ts)';
    const [match] = findLinkMatches(line);
    expect(match?.candidates).toEqual([{ start: 7, path: 'src/main/index.ts' }]);
    expect(line.slice(7, 7 + 'src/main/index.ts'.length)).toBe('src/main/index.ts');
  });

  it('finds Edit and Update calls', () => {
    expect(summarize('● Edit(src/renderer/src/App.tsx)').map((m) => m.path)).toEqual(['src/renderer/src/App.tsx']);
    expect(summarize('● Update(package.json)').map((m) => m.path)).toEqual(['package.json']);
  });

  it('finds path:line', () => {
    expect(plain('src/main/pty.ts:42')).toEqual([{ path: 'src/main/pty.ts', start: 0, line: 42, endLine: undefined }]);
  });

  it('finds path:line-line ranges', () => {
    expect(plain('see src/main/pty.ts:42-50 for details')).toEqual([
      { path: 'src/main/pty.ts', start: 4, line: 42, endLine: 50 },
    ]);
  });

  it('accepts a trailing column after the line', () => {
    expect(plain('  at src/x.ts:10:5')).toEqual([{ path: 'src/x.ts', start: 5, line: 10, endLine: undefined }]);
  });

  it('finds a path without a line number', () => {
    expect(summarize('modified: docs/readme.md')).toEqual([
      { path: 'docs/readme.md', start: 10, line: undefined, endLine: undefined },
    ]);
  });

  it('finds paths with spaces when a line follows, longest candidate first', () => {
    const [match] = findLinkMatches('path/with spaces.md:3');
    expect(match?.candidates).toEqual([{ start: 0, path: 'path/with spaces.md' }]);
    expect(match?.line).toBe(3);

    const [prefixed] = findLinkMatches('error in path/with spaces.md:3');
    expect(prefixed?.candidates.map((c) => c.path)).toEqual([
      'error in path/with spaces.md',
      'in path/with spaces.md',
      'path/with spaces.md',
    ]);
  });

  it('finds home-relative and absolute paths', () => {
    expect(summarize('~/notes/todo.md:7').map((m) => [m.path, m.line])).toEqual([['~/notes/todo.md', 7]]);
    expect(summarize('/Users/me/app/src/a.ts:1').map((m) => [m.path, m.line])).toEqual([['/Users/me/app/src/a.ts', 1]]);
  });

  it('finds dotfiles and relative paths', () => {
    expect(summarize('.gitignore').map((m) => m.path)).toEqual(['.gitignore']);
    expect(summarize('./scripts/gates.sh').map((m) => m.path)).toEqual(['./scripts/gates.sh']);
  });

  it('finds several references in one line', () => {
    expect(summarize('src/a.ts:1 src/b.ts:2').map((m) => [m.path, m.line])).toEqual([
      ['src/a.ts', 1],
      ['src/b.ts', 2],
    ]);
  });

  it('strips quotes and trailing punctuation', () => {
    expect(summarize('"src/a.ts",').map((m) => [m.path, m.start])).toEqual([['src/a.ts', 1]]);
  });

  it('ignores URLs and plain words', () => {
    expect(summarize('open https://example.com/a/b.html now')).toEqual([]);
    expect(summarize('nothing to see here')).toEqual([]);
  });

  it('does not report a tool-call path twice', () => {
    expect(summarize('Read(src/main/index.ts)')).toHaveLength(1);
  });
});

describe('lineCells', () => {
  /** A fake buffer line: wide characters take two cells, the second one empty with width 0. */
  function fakeLine(chars: { c: string; w: number }[]) {
    const cells: { c: string; w: number }[] = [];
    for (const ch of chars) {
      cells.push(ch);
      if (ch.w === 2) cells.push({ c: '', w: 0 });
    }
    return {
      length: cells.length,
      getCell: (x: number) => {
        const cell = cells[x];
        return cell ? { getChars: () => cell.c, getWidth: () => cell.w } : undefined;
      },
    };
  }

  it('maps string offsets to cell columns past wide characters', () => {
    const line = fakeLine([{ c: '\u2705', w: 2 }, ...[...' src/a.ts:3'].map((c) => ({ c, w: 1 }))]);
    const { text, columnOf } = lineCells(line);
    expect(text).toBe('\u2705 src/a.ts:3');
    const match = findLinkMatches(text)[0];
    const start = match?.candidates[0]?.start ?? -1;
    expect(start).toBe(2);
    // 's' sits in cell 3: the check mark fills cells 0 and 1, the space cell 2.
    expect(columnOf(start)).toBe(3);
  });

  it('is the identity for plain ASCII', () => {
    const line = fakeLine([...'a b'].map((c) => ({ c, w: 1 })));
    const { text, columnOf } = lineCells(line);
    expect(text).toBe('a b');
    expect([0, 1, 2].map(columnOf)).toEqual([0, 1, 2]);
  });
});
