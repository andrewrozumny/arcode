import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrepQuery } from '@shared/files';
import {
  GrepCollector,
  buildGitGrepArgs,
  buildMatcher,
  buildRgArgs,
  byteToCharOffset,
  findRanges,
  findRipgrep,
  globToRegExp,
  grepProject,
  includeFilter,
  parseGitGrepLine,
  parseIncludes,
  parseRgLine,
  trimPreview,
} from './grep';

const q = (query: string, extra: Partial<GrepQuery> = {}): GrepQuery => ({
  query,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: '',
  ...extra,
});

describe('parseIncludes', () => {
  it('splits on commas outside braces and separates exclusions', () => {
    expect(parseIncludes(' *.ts, src/*.{ts,tsx} ,!*.test.ts, ,! ')).toEqual({
      include: ['*.ts', 'src/*.{ts,tsx}'],
      exclude: ['*.test.ts'],
    });
    expect(parseIncludes('')).toEqual({ include: [], exclude: [] });
  });
});

describe('buildRgArgs', () => {
  it('builds a literal, case-insensitive search by default', () => {
    expect(buildRgArgs(q('a.b'))).toEqual([
      '--json',
      '--no-config',
      '--no-require-git',
      '--hidden',
      '--glob',
      '!.git',
      '--max-filesize',
      '2M',
      '--ignore-case',
      '--fixed-strings',
      '--regexp',
      'a.b',
      '--',
      '.',
    ]);
  });

  it('maps toggles and globs to flags and keeps the query as one argument', () => {
    const args = buildRgArgs(q('-rf; $(x)', { caseSensitive: true, wholeWord: true, regex: true, include: '*.ts,!*.d.ts' }));
    expect(args).toContain('--case-sensitive');
    expect(args).toContain('--word-regexp');
    expect(args).not.toContain('--fixed-strings');
    expect(args.slice(args.indexOf('--case-sensitive'))).toEqual([
      '--case-sensitive',
      '--word-regexp',
      '--glob',
      '*.ts',
      '--glob',
      '!*.d.ts',
      '--regexp',
      '-rf; $(x)',
      '--',
      '.',
    ]);
  });
});

describe('buildGitGrepArgs', () => {
  it('builds a literal search with pathspecs for include and exclude', () => {
    expect(buildGitGrepArgs(q('needle', { include: '*.ts, !vendor/**' }))).toEqual([
      'grep',
      '-n',
      '-I',
      '--untracked',
      '-z',
      '--no-color',
      '-i',
      '-F',
      '-e',
      'needle',
      '--',
      '*.ts',
      ':(exclude)vendor/**',
    ]);
  });

  it('uses PCRE for regex, or -E when asked, and -w for whole words', () => {
    const args = buildGitGrepArgs(q('fo+', { regex: true, wholeWord: true, caseSensitive: true }));
    expect(args).toContain('-P');
    expect(args).toContain('-w');
    expect(args).not.toContain('-i');
    expect(buildGitGrepArgs(q('fo+', { regex: true }), false)).toContain('-E');
  });
});

describe('buildMatcher and findRanges', () => {
  it('escapes literal queries', () => {
    expect(findRanges(buildMatcher(q('a.b')), 'axb a.b A.B').ranges).toEqual([
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it('honors case sensitivity and whole words', () => {
    expect(findRanges(buildMatcher(q('Foo', { caseSensitive: true })), 'foo Foo').ranges).toEqual([{ start: 4, end: 7 }]);
    expect(findRanges(buildMatcher(q('foo', { wholeWord: true })), 'foobar foo _foo foo.').ranges).toEqual([
      { start: 7, end: 10 },
      { start: 16, end: 19 },
    ]);
  });

  it('accepts regexes, rejects invalid ones and skips empty matches', () => {
    expect(findRanges(buildMatcher(q('\\d+', { regex: true })), 'a1 b22').ranges).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 6 },
    ]);
    expect(() => buildMatcher(q('(', { regex: true }))).toThrow();
    expect(findRanges(buildMatcher(q('x*', { regex: true })), 'abxxc')).toEqual({ ranges: [{ start: 2, end: 4 }], count: 1 });
  });

  it('caps recorded ranges but keeps the count', () => {
    const found = findRanges(buildMatcher(q('a')), 'a'.repeat(80), 5);
    expect(found.ranges).toHaveLength(5);
    expect(found.count).toBe(80);
  });
});

describe('trimPreview', () => {
  it('drops indentation and shifts ranges', () => {
    expect(trimPreview('    const x = 1;\r\n', [{ start: 10, end: 11 }])).toEqual({
      text: 'const x = 1;',
      ranges: [{ start: 6, end: 7 }],
    });
  });

  it('keeps a short line as it is', () => {
    expect(trimPreview('abc', [{ start: 0, end: 1 }])).toEqual({ text: 'abc', ranges: [{ start: 0, end: 1 }] });
  });

  it('trims a long line around the match with ellipses', () => {
    const line = 'x'.repeat(500) + 'NEEDLE' + 'y'.repeat(500);
    const { text, ranges } = trimPreview(line, [{ start: 500, end: 506 }], 100);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBe(102);
    expect(ranges).toHaveLength(1);
    const [r] = ranges;
    expect(text.slice(r?.start, r?.end)).toBe('NEEDLE');
    expect(r?.start).toBe(13);
  });

  it('cuts the start of a short line when the match is far into it', () => {
    const line = 'A tiny HTTP service that schedules satellite passes over ground stations.';
    const at = line.indexOf('stations');
    const { text, ranges } = trimPreview(line, [{ start: at, end: at + 8 }]);
    expect(text).toBe('…' + line.slice(at - 12));
    expect(ranges).toEqual([{ start: 13, end: 21 }]);
  });

  it('shifts the window back when the match is near the end', () => {
    const line = 'a'.repeat(300) + 'END';
    const { text, ranges } = trimPreview(line, [{ start: 300, end: 303 }], 50);
    expect(text).toBe('…' + 'a'.repeat(47) + 'END');
    expect(ranges).toEqual([{ start: 48, end: 51 }]);
  });

  it('drops ranges that fall outside the window', () => {
    const line = 'A' + 'y'.repeat(300) + 'B';
    const { text, ranges } = trimPreview(line, [{ start: 0, end: 1 }, { start: 301, end: 302 }], 50);
    expect(text).toBe('A' + 'y'.repeat(49) + '…');
    expect(ranges).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('byteToCharOffset', () => {
  it('maps UTF-8 byte offsets to UTF-16 offsets', () => {
    expect(byteToCharOffset('abc', 2)).toBe(2);
    // 'é' is 2 bytes, the emoji is 4 bytes and 2 UTF-16 units.
    expect(byteToCharOffset('é😀x', 2)).toBe(1);
    expect(byteToCharOffset('é😀x', 6)).toBe(3);
  });
});

describe('parseRgLine', () => {
  const match = (data: object): string => JSON.stringify({ type: 'match', data });

  it('parses a match record with byte offsets', () => {
    const hit = parseRgLine(
      match({
        path: { text: './src/a.ts' },
        lines: { text: 'const café = café;\n' },
        line_number: 3,
        absolute_offset: 10,
        submatches: [
          { match: { text: 'café' }, start: 6, end: 11 },
          { match: { text: 'café' }, start: 14, end: 19 },
        ],
      }),
    );
    expect(hit).toEqual({
      path: 'src/a.ts',
      line: 3,
      text: 'const café = café;',
      ranges: [
        { start: 6, end: 10 },
        { start: 13, end: 17 },
      ],
      count: 2,
    });
  });

  it('decodes base64 paths and lines', () => {
    const hit = parseRgLine(
      match({
        path: { bytes: Buffer.from('odd.txt').toString('base64') },
        lines: { bytes: Buffer.from('hi there').toString('base64') },
        line_number: 1,
        submatches: [{ start: 3, end: 8 }],
      }),
    );
    expect(hit?.path).toBe('odd.txt');
    expect(hit?.ranges).toEqual([{ start: 3, end: 8 }]);
  });

  it('ignores other record types and malformed input', () => {
    expect(parseRgLine(JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } }))).toBeNull();
    expect(parseRgLine(JSON.stringify({ type: 'summary', data: {} }))).toBeNull();
    expect(parseRgLine('not json')).toBeNull();
    expect(parseRgLine(match({ path: { text: 'a' }, lines: { text: 'x' } }))).toBeNull();
  });
});

describe('parseGitGrepLine', () => {
  it('splits path, line and text on NUL', () => {
    expect(parseGitGrepLine('src/a:b.ts\x0012\x00  x: y\0z\r')).toEqual({ path: 'src/a:b.ts', line: 12, text: '  x: y\0z' });
  });

  it('rejects malformed records', () => {
    expect(parseGitGrepLine('')).toBeNull();
    expect(parseGitGrepLine('a.ts:3:text')).toBeNull();
    expect(parseGitGrepLine('a.ts\0x\0text')).toBeNull();
    expect(parseGitGrepLine('a.ts\x000\x00text')).toBeNull();
  });
});

describe('globToRegExp and includeFilter', () => {
  it('matches basenames at any depth when the glob has no slash', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/deep/a.ts')).toBe(true);
    expect(re.test('a.tsx')).toBe(false);
  });

  it('anchors globs with a slash and supports ** and braces', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true);
    expect(globToRegExp('*.{ts,tsx}').test('b/c.tsx')).toBe(true);
    expect(globToRegExp('docs/').test('docs/a.md')).toBe(true);
    expect(globToRegExp('file?.[ch]').test('file1.c')).toBe(true);
  });

  it('combines includes and excludes', () => {
    const accept = includeFilter('*.ts, !*.test.ts');
    expect(accept('src/a.ts')).toBe(true);
    expect(accept('src/a.test.ts')).toBe(false);
    expect(accept('README.md')).toBe(false);
    expect(includeFilter('')('anything')).toBe(true);
  });
});

describe('GrepCollector', () => {
  it('groups by file, counts occurrences and sorts', () => {
    const c = new GrepCollector({ maxLines: 10, maxFiles: 10, maxPreview: 240 });
    c.add({ path: 'b.ts', line: 5, text: 'x x', ranges: [{ start: 0, end: 1 }, { start: 2, end: 3 }] });
    c.add({ path: 'a.ts', line: 9, text: '  y', ranges: [{ start: 2, end: 3 }] });
    c.add({ path: 'a.ts', line: 2, text: 'y', ranges: [{ start: 0, end: 1 }], count: 3 });
    const r = c.result('git');
    expect(r.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(r.files[0]?.matches.map((m) => m.line)).toEqual([2, 9]);
    expect(r.files[0]?.matches[1]).toEqual({ line: 9, column: 3, text: 'y', ranges: [{ start: 0, end: 1 }] });
    expect(r.files[0]?.count).toBe(4);
    expect(r.totalLines).toBe(3);
    expect(r.totalCount).toBe(6);
    expect(r.truncated).toBe(false);
  });

  it('stops at the line cap', () => {
    const c = new GrepCollector({ maxLines: 2, maxFiles: 10, maxPreview: 240 });
    const hit = (line: number) => ({ path: 'a', line, text: 'a', ranges: [{ start: 0, end: 1 }] });
    expect(c.add(hit(1))).toBe(true);
    expect(c.add(hit(2))).toBe(false);
    expect(c.add(hit(3))).toBe(false);
    expect(c.result('rg')).toMatchObject({ totalLines: 2, truncated: true });
  });

  it('stops at the file cap', () => {
    const c = new GrepCollector({ maxLines: 10, maxFiles: 1, maxPreview: 240 });
    expect(c.add({ path: 'a', line: 1, text: 'a', ranges: [] })).toBe(true);
    expect(c.add({ path: 'a', line: 2, text: 'a', ranges: [] })).toBe(true);
    expect(c.add({ path: 'b', line: 1, text: 'a', ranges: [] })).toBe(false);
    expect(c.result('rg')).toMatchObject({ totalLines: 2, truncated: true });
  });
});

describe('grepProject', () => {
  let root: string;
  let outside: string;

  const write = (rel: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'arcode-grep-'));
    outside = mkdtempSync(join(tmpdir(), 'arcode-grep-out-'));
    write('src/a.ts', 'const needle = 1;\nexport const NeedleCase = needle + 1;\n');
    write('src/b.md', 'a needle in the docs\n');
    write('ignored/c.ts', 'needle\n');
    write('.gitignore', 'ignored/\n');
    write('bin.dat', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1, 2]));
    writeFileSync(join(outside, 'secret.ts'), 'needle outside\n');
    symlinkSync(outside, join(root, 'link'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('returns nothing for an empty query', async () => {
    expect((await grepProject(root, q(''), { engines: ['node'] })).files).toEqual([]);
  });

  it('searches with the Node engine, honoring .gitignore, binaries and includes', async () => {
    const r = await grepProject(root, q('needle'), { engines: ['node'] });
    expect(r.engine).toBe('node');
    expect(r.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.md']);
    expect(r.files[0]?.matches.map((m) => [m.line, m.column])).toEqual([
      [1, 7],
      [2, 14],
    ]);
    const ts = await grepProject(root, q('needle', { include: '*.ts' }), { engines: ['node'] });
    expect(ts.files.map((f) => f.path)).toEqual(['src/a.ts']);
    const cs = await grepProject(root, q('Needle', { caseSensitive: true }), { engines: ['node'] });
    expect(cs.totalLines).toBe(1);
  });

  it('reports an invalid regex instead of throwing', async () => {
    const r = await grepProject(root, q('(', { regex: true }), { engines: ['node'] });
    expect(r.error).toBeTruthy();
    expect(r.files).toEqual([]);
  });

  it('honors the line cap', async () => {
    const r = await grepProject(root, q('needle'), { engines: ['node'], limits: { maxLines: 1 } });
    expect(r.totalLines).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it('comes back cancelled when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await grepProject(root, q('needle'), { engines: ['node'], signal: controller.signal });
    expect(r.cancelled).toBe(true);
  });

  it('searches with git grep, untracked files included and ignored files left out', async () => {
    // A separate folder: isGitRepo caches the answer for the Node engine's root.
    const repo = mkdtempSync(join(tmpdir(), 'arcode-grep-git-'));
    try {
      mkdirSync(join(repo, 'src'));
      mkdirSync(join(repo, 'ignored'));
      writeFileSync(join(repo, 'src/a.ts'), 'const needle = 1;\nexport const NeedleCase = needle + 1;\n');
      writeFileSync(join(repo, 'src/b.md'), 'a needle in the docs\n');
      writeFileSync(join(repo, 'ignored/c.ts'), 'needle\n');
      writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const r = await grepProject(repo, q('needle'), { engines: ['git'] });
      expect(r.engine).toBe('git');
      expect(r.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.md']);
      expect(r.files[0]?.matches[1]).toMatchObject({ line: 2, column: 14, ranges: [{ start: 13, end: 19 }, { start: 26, end: 32 }] });
      const word = await grepProject(repo, q('needl', { wholeWord: true }), { engines: ['git'] });
      expect(word.totalLines).toBe(0);
      const re = await grepProject(repo, q('need\\w+ in', { regex: true }), { engines: ['git'] });
      expect(re.files.map((f) => f.path)).toEqual(['src/b.md']);
      const ts = await grepProject(repo, q('needle', { include: '*.ts' }), { engines: ['git'] });
      expect(ts.files.map((f) => f.path)).toEqual(['src/a.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('searches with ripgrep when it is installed', async () => {
    if (!(await findRipgrep())) return; // ripgrep is optional
    const r = await grepProject(root, q('needle'), { engines: ['rg'] });
    expect(r.engine).toBe('rg');
    expect(r.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.md']);
    expect(r.files[0]?.matches[1]).toMatchObject({ line: 2, column: 14 });
  });

  it('falls through to the next engine when one is unavailable', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'arcode-grep-plain-'));
    try {
      writeFileSync(join(plain, 'x.txt'), 'needle\n');
      const r = await grepProject(plain, q('needle'), { engines: ['git', 'node'] });
      expect(r.engine).toBe('node');
      expect(r.totalLines).toBe(1);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
