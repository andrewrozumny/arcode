import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContentCache } from './contentCache';
import { LocalHistory, PROJECT_SNAPSHOT_COOLDOWN_MS } from './history';
import { headTexts, ProjectHistory } from './projectHistory';
import { writeFile } from './service';

describe('ContentCache', () => {
  it('evicts the least recently used entries past the memory budget', () => {
    // Budget of 20 bytes: two 4-character entries (8 bytes each) fit, a third pushes the oldest out.
    const cache = new ContentCache(20, 100);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');
    expect(cache.get('a')).toBe('aaaa'); // a is now the most recent
    cache.set('c', 'cccc');
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe('aaaa');
    expect(cache.get('c')).toBe('cccc');
    expect(cache.bytes).toBe(16);
  });

  it('caps the entry count, counts null as free and refuses content over the budget', () => {
    const cache = new ContentCache(1000, 2);
    cache.set('a', null);
    cache.set('b', null);
    cache.set('c', 'x');
    expect(cache.size).toBe(2);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBeNull();
    cache.set('big', 'y'.repeat(600));
    expect(cache.has('big')).toBe(false);
    cache.set('c', 'longer');
    expect(cache.bytes).toBe(12);
    cache.delete('c');
    expect(cache.bytes).toBe(0);
    expect(cache.get('c')).toBeUndefined();
  });
});

describe('ProjectHistory', () => {
  let tmp: string;
  let root: string;
  let clock: number;
  let history: LocalHistory;
  let logs: string[];
  let project: ProjectHistory;

  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
  };
  const file = (rel: string): string => join(root, rel);
  const versions = async (rel: string): Promise<string[]> => {
    const list = await history.list(root, file(rel));
    return Promise.all(list.map(async (s) => (await history.read(root, file(rel), s.id)) ?? ''));
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'arcode-project-history-')));
    root = join(tmp, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
    git('init', '-q');
    writeFileSync(file('src/a.ts'), 'committed a');
    writeFileSync(file('src/b.ts'), 'committed b');
    writeFileSync(file('.gitignore'), 'logs/\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    clock = 1_700_000_000_000;
    const now = (): number => clock;
    history = new LocalHistory(join(tmp, 'userData', 'history'), now);
    logs = [];
    project = new ProjectHistory(history, { bulkLimit: 5, log: (m) => logs.push(m), now });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads HEAD versions in one batch', async () => {
    writeFileSync(file('bin.dat'), Buffer.from([1, 0, 2]));
    git('add', 'bin.dat');
    git('commit', '-qm', 'bin');
    const texts = await headTexts(root, ['src/a.ts', 'missing.ts', 'src', 'bin.dat', 'src/b.ts']);
    expect(texts.get('src/a.ts')).toBe('committed a');
    expect(texts.get('missing.ts')).toBeNull();
    expect(texts.get('src')).toBeNull();
    expect(texts.get('bin.dat')).toBeNull();
    expect(texts.get('src/b.ts')).toBe('committed b');
    expect((await headTexts(tmp, ['x'])).size).toBe(0);
  });

  it('keeps the HEAD version on the first change of a closed committed file, then the cached one', async () => {
    writeFileSync(file('src/a.ts'), 'claude 1');
    expect(await project.changed(root, ['src/a.ts'])).toBe(1);
    expect(await versions('src/a.ts')).toEqual(['committed a']);

    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    writeFileSync(file('src/a.ts'), 'claude 2');
    expect(await project.changed(root, ['src/a.ts'])).toBe(1);
    expect(await versions('src/a.ts')).toEqual(['claude 1', 'committed a']);

    // Deleted from outside: the last content is kept.
    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    rmSync(file('src/a.ts'));
    expect(await project.changed(root, ['src/a.ts'])).toBe(1);
    expect((await versions('src/a.ts'))[0]).toBe('claude 2');
  });

  it('takes nothing when the content is identical to what was known', async () => {
    // Touched but unchanged (for example `git checkout -- file` or a formatter with nothing to do).
    expect(await project.changed(root, ['src/b.ts'])).toBe(0);
    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    expect(await project.changed(root, ['src/b.ts'])).toBe(0);
    expect(await history.list(root, file('src/b.ts'))).toHaveLength(0);
  });

  it('caches new untracked files and keeps them from their second change on', async () => {
    writeFileSync(file('notes.md'), 'first');
    expect(await project.changed(root, ['notes.md'])).toBe(0);
    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    writeFileSync(file('notes.md'), 'second');
    expect(await project.changed(root, ['notes.md'])).toBe(1);
    expect(await versions('notes.md')).toEqual(['first']);
  });

  it('keeps at most one version per file per cooldown', async () => {
    writeFileSync(file('src/a.ts'), 'one');
    expect(await project.changed(root, ['src/a.ts'])).toBe(1);
    clock += 1000;
    writeFileSync(file('src/a.ts'), 'two');
    expect(await project.changed(root, ['src/a.ts'])).toBe(0);
    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    writeFileSync(file('src/a.ts'), 'three');
    expect(await project.changed(root, ['src/a.ts'])).toBe(1);
    expect(await versions('src/a.ts')).toEqual(['two', 'committed a']);
  });

  it('skips gitignored files, binaries and paths outside the project', async () => {
    mkdirSync(file('logs'));
    writeFileSync(file('logs/run.log'), 'line');
    writeFileSync(file('img.bin'), Buffer.from([1, 0, 2]));
    expect(await project.changed(root, ['logs/run.log', 'img.bin', '../outside.txt', 'node_modules/x.js'])).toBe(0);
    writeFileSync(file('logs/run.log'), 'line 2');
    writeFileSync(file('img.bin'), Buffer.from([3, 0, 4]));
    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    expect(await project.changed(root, ['logs/run.log', 'img.bin'])).toBe(0);
    expect(history.isKnown(file('logs/run.log'))).toBe(false);
  });

  it('snapshots nothing during a bulk change, drops stale cache and logs once', async () => {
    // Cache src/a.ts at its committed content.
    expect(await project.changed(root, ['src/a.ts'])).toBe(0);
    expect(history.isKnown(file('src/a.ts'))).toBe(true);

    clock += 60_000;
    const many = Array.from({ length: 8 }, (_v, i) => `gen/f${i}.ts`);
    mkdirSync(file('gen'));
    for (const rel of many) writeFileSync(file(rel), 'generated');
    writeFileSync(file('src/a.ts'), 'from another branch');
    expect(await project.changed(root, [...many, 'src/a.ts'])).toBe(0);
    expect(await project.changed(root, [...many, 'src/a.ts'])).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/bulk change of 9 files/);
    expect(history.isKnown(file('src/a.ts'))).toBe(false);
    expect(await history.list(root, file('src/a.ts'))).toHaveLength(0);
  });

  it('keeps cache an open file refreshed during the bulk change', async () => {
    await history.prime(file('src/b.ts'));
    clock += 60_000;
    writeFileSync(file('src/b.ts'), 'checked out');
    // The open file's own watcher caught up first.
    await history.externalChange(root, file('src/b.ts'));
    const many = Array.from({ length: 8 }, (_v, i) => `gen${i}.ts`);
    expect(await project.changed(root, [...many, 'src/b.ts'])).toBe(0);
    expect(history.isKnown(file('src/b.ts'))).toBe(true);
  });

  it('ignores ARcode saves and changes the open file watcher already handled', async () => {
    const abs = file('src/b.ts');
    await history.prime(abs);
    await writeFile(root, 'src/b.ts', 'mine', statSync(abs).mtimeMs, history.writeHooks(root));
    expect(await project.changed(root, ['src/b.ts'])).toBe(0);
    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    writeFileSync(abs, 'claude');
    expect(await history.externalChange(root, abs)).toBe(true);
    expect(await project.changed(root, ['src/b.ts'])).toBe(0);
    expect(await versions('src/b.ts')).toEqual(['mine', 'committed b']);
  });

  it('works outside git with the .gitignore fallback and no HEAD seed', async () => {
    const plain = join(tmp, 'plain');
    mkdirSync(join(plain, 'tmp'), { recursive: true });
    writeFileSync(join(plain, '.gitignore'), 'tmp/\n');
    writeFileSync(join(plain, 'a.txt'), 'one');
    writeFileSync(join(plain, 'tmp/x.txt'), 'one');
    expect(await project.changed(plain, ['a.txt', 'tmp/x.txt'])).toBe(0);
    clock += PROJECT_SNAPSHOT_COOLDOWN_MS;
    writeFileSync(join(plain, 'a.txt'), 'two');
    writeFileSync(join(plain, 'tmp/x.txt'), 'two');
    expect(await project.changed(plain, ['a.txt', 'tmp/x.txt'])).toBe(1);
    expect(history.isKnown(join(plain, 'tmp/x.txt'))).toBe(false);
  });
});
