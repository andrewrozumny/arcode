import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countLines, getChanges, mergeChanges, parseNumstat } from './changes';
import { parsePorcelainEntries } from './gitStatus';

describe('parseNumstat', () => {
  it('reads plain, binary and renamed records', () => {
    const out = ['3\t1\tsrc/a b.ts', '-\t-\tlogo.png', '0\t12\tgone.ts', '2\t0\t', 'old/name.ts', 'new/name.ts', ''].join('\0');
    const map = parseNumstat(out);
    expect(map.get('src/a b.ts')).toEqual({ added: 3, deleted: 1, binary: false });
    expect(map.get('logo.png')).toEqual({ added: null, deleted: null, binary: true });
    expect(map.get('gone.ts')).toEqual({ added: 0, deleted: 12, binary: false });
    expect(map.get('new/name.ts')).toEqual({ added: 2, deleted: 0, binary: false });
    expect(map.has('old/name.ts')).toBe(false);
    expect(map.size).toBe(4);
  });

  it('ignores empty and malformed output', () => {
    expect(parseNumstat('').size).toBe(0);
    expect(parseNumstat('garbage\0').size).toBe(0);
  });
});

describe('countLines', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it('counts lines with and without a trailing newline', () => {
    expect(countLines(enc(''))).toBe(0);
    expect(countLines(enc('a\nb\n'))).toBe(2);
    expect(countLines(enc('a\nb'))).toBe(2);
  });
  it('treats a NUL near the start as binary', () => {
    expect(countLines(new Uint8Array([65, 0, 66]))).toBeNull();
  });
});

describe('parsePorcelainEntries', () => {
  it('keeps the original path of a rename', () => {
    const out = ['2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts', 'old/name.ts', '? x.md', ''].join('\0');
    expect(parsePorcelainEntries(out)).toEqual([
      { path: 'new/name.ts', code: 'R', origPath: 'old/name.ts' },
      { path: 'x.md', code: '?' },
    ]);
  });
});

describe('mergeChanges', () => {
  it('joins counts, re-bases onto a subfolder and sorts by path', () => {
    const entries = parsePorcelainEntries(
      [
        '1 .M N... 100644 100644 100644 aaa bbb app/z.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R90 app/new.ts',
        'other/old.ts',
        '1 .M N... 100644 100644 100644 aaa bbb outside.ts',
        '? app/a.md',
        '',
      ].join('\0'),
    );
    const numstat = parseNumstat(['4\t2\tz.ts', ''].join('\0'));
    expect(mergeChanges(entries, numstat, 'app/')).toEqual([
      { path: 'a.md', status: '?', added: null, deleted: null, binary: false },
      { path: 'new.ts', status: 'R', added: null, deleted: null, binary: false },
      { path: 'z.ts', status: 'M', added: 4, deleted: 2, binary: false },
    ]);
  });
});

describe('getChanges', () => {
  it('reports modified, added, deleted, renamed and untracked files with counts', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'acode-changes-'));
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
      };
      git('init', '-q');
      await mkdir(join(repo, 'src'));
      await writeFile(join(repo, 'src/a.ts'), 'one\ntwo\nthree\n');
      await writeFile(join(repo, 'gone.ts'), 'x\ny\n');
      await writeFile(join(repo, 'move.ts'), 'a\nb\nc\nd\ne\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      await writeFile(join(repo, 'src/a.ts'), 'one\n2\nthree\nfour\n');
      await rm(join(repo, 'gone.ts'));
      git('mv', 'move.ts', 'moved.ts');
      await writeFile(join(repo, 'staged.ts'), 'new\n');
      git('add', 'staged.ts');
      await writeFile(join(repo, 'notes.md'), 'l1\nl2\nl3');

      const result = await getChanges(repo);
      expect(result.git).toBe(true);
      expect(result.files).toEqual([
        { path: 'gone.ts', status: 'D', added: 0, deleted: 2, binary: false },
        { path: 'moved.ts', status: 'R', origPath: 'move.ts', added: 0, deleted: 0, binary: false },
        { path: 'notes.md', status: '?', added: 3, deleted: 0, binary: false },
        { path: 'src/a.ts', status: 'M', added: 2, deleted: 1, binary: false },
        { path: 'staged.ts', status: 'A', added: 1, deleted: 0, binary: false },
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('says so outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acode-changes-nogit-'));
    try {
      expect(await getChanges(dir)).toEqual({ git: false, files: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
