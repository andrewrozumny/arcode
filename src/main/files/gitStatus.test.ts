import { execFileSync } from 'node:child_process';
import { statSync, utimesSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateDirs, getGitStatus, parsePorcelainV2, stripPrefix } from './gitStatus';

describe('parsePorcelainV2', () => {
  it('parses ordinary, renamed, unmerged and untracked records', () => {
    const out = [
      '1 .M N... 100644 100644 100644 aaa bbb src/mod ified.ts',
      '1 A. N... 000000 100644 100644 000 bbb src/new.ts',
      '1 .D N... 100644 100644 000000 aaa bbb gone.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts',
      'old/name.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
      '? docs/untracked.md',
      '',
    ].join('\0');
    expect(parsePorcelainV2(out)).toEqual({
      'src/mod ified.ts': 'M',
      'src/new.ts': 'A',
      'gone.ts': 'D',
      'new/name.ts': 'R',
      'conflict.ts': 'U',
      'docs/untracked.md': '?',
    });
  });
  it('returns an empty map for empty output', () => {
    expect(parsePorcelainV2('')).toEqual({});
  });
});

describe('aggregateDirs', () => {
  it('lists every ancestor folder once', () => {
    expect(aggregateDirs({ 'a/b/c.ts': 'M', 'a/d.ts': '?', 'top.ts': 'M', 'x/y/z/w.ts': 'A' })).toEqual([
      'a',
      'a/b',
      'x',
      'x/y',
      'x/y/z',
    ]);
  });
});

describe('stripPrefix', () => {
  it('rebases onto a subfolder and drops outside files', () => {
    expect(stripPrefix({ 'app/a.ts': 'M', 'other/b.ts': 'M' }, 'app/')).toEqual({ 'a.ts': 'M' });
  });
});

describe('getGitStatus', () => {
  it('returns an empty map outside git without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acode-nogit-'));
    expect(await getGitStatus(dir)).toEqual({ files: {}, dirs: [] });
  });
  it('reports untracked and modified files with folder aggregation, from a subfolder root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'acode-git-'));
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
    };
    git('init', '-q');
    await mkdir(join(repo, 'app/src'), { recursive: true });
    await writeFile(join(repo, 'app/src/a.ts'), '1');
    await writeFile(join(repo, 'app/b.ts'), '1');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    await writeFile(join(repo, 'app/src/a.ts'), '2');
    await mkdir(join(repo, 'app/new'));
    await writeFile(join(repo, 'app/new/c.ts'), '1');
    const map = await getGitStatus(join(repo, 'app'));
    expect(map.files).toEqual({ 'src/a.ts': 'M', 'new/c.ts': '?' });
    expect(map.dirs).toEqual(['new', 'src']);
  });

  it('never rewrites .git/index, so it cannot hold index.lock while the user commits', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'acode-git-lock-'));
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
    };
    git('init', '-q');
    await writeFile(join(repo, 'a.ts'), '1');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    // Same content, newer mtime: a plain `git status` refreshes the stat cache and rewrites the index.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo, 'a.ts'), later, later);
    const before = statSync(join(repo, '.git', 'index')).mtimeMs;
    await new Promise((done) => setTimeout(done, 20));
    await getGitStatus(repo);
    expect(statSync(join(repo, '.git', 'index')).mtimeMs).toBe(before);
  });
});
