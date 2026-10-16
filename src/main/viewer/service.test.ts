import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headContent, looksBinary, readFile, watchFile, writeFile } from './service';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'viewer-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
  writeFileSync(join(root, 'p.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'sub/b.ts'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: root,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('readFile', () => {
  it('reads text', async () => {
    expect(await readFile(root, 'a.txt')).toMatchObject({ kind: 'text', content: 'hello', size: 5 });
  });
  it('detects binary by NUL byte', async () => {
    expect(await readFile(root, 'bin.dat')).toMatchObject({ kind: 'binary', size: 4 });
    expect(looksBinary(Buffer.from('plain'))).toBe(false);
    expect(looksBinary(Buffer.from([65, 0]))).toBe(true);
  });
  it('flags oversized text', async () => {
    expect(await readFile(root, 'big.txt')).toMatchObject({ kind: 'tooLarge' });
  });
  it('returns svg as image with source', async () => {
    const r = await readFile(root, 'p.svg');
    expect(r).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    expect(r.kind === 'image' && r.svgSource).toContain('<svg');
  });
  it('returns an error instead of escaping the root', async () => {
    expect((await readFile(root, '../etc/hosts')).kind).toBe('error');
  });
  it('refuses a symlink that leads out of the project, like the tree does', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'viewer-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    try {
      expect(await readFile(root, 'link.txt')).toMatchObject({ kind: 'error' });
      expect(await writeFile(root, 'link.txt', 'y', null)).toMatchObject({ ok: false, reason: 'error' });
    } finally {
      rmSync(join(root, 'link.txt'));
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('writeFile', () => {
  it('writes when the mtime matches', async () => {
    const r = await readFile(root, 'a.txt');
    if (r.kind !== 'text') throw new Error('expected text');
    expect((await writeFile(root, 'a.txt', 'changed', r.mtime)).ok).toBe(true);
    expect(await readFile(root, 'a.txt')).toMatchObject({ content: 'changed' });
  });
  it('reports a conflict when the file changed on disk', async () => {
    const r = await readFile(root, 'a.txt');
    if (r.kind !== 'text') throw new Error('expected text');
    utimesSync(join(root, 'a.txt'), new Date(), new Date(Date.now() + 5000));
    expect(await writeFile(root, 'a.txt', 'mine', r.mtime)).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await readFile(root, 'a.txt')).toMatchObject({ content: 'changed' });
  });
  it('creates new files only when none exists', async () => {
    expect((await writeFile(root, 'new.txt', 'x', null)).ok).toBe(true);
    expect(await writeFile(root, 'new.txt', 'y', null)).toMatchObject({ ok: false, reason: 'conflict' });
  });
  it('refuses to write outside the root', async () => {
    expect(await writeFile(root, '../evil.txt', 'x', null)).toMatchObject({ ok: false, reason: 'error' });
  });
});

describe('headContent', () => {
  it('returns committed content', async () => {
    expect(await headContent(root, 'sub/b.ts')).toBe('export const b = 1;\n');
  });
  it('returns null for untracked files and escaping paths', async () => {
    expect(await headContent(root, 'a.txt')).toBeNull();
    expect(await headContent(root, '../x')).toBeNull();
  });
});

describe('watchFile', () => {
  const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  it('reports a file that comes back after it was deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'viewer-watch-'));
    writeFileSync(join(dir, 'w.txt'), 'one');
    const seen: (number | null)[] = [];
    const dispose = watchFile(join(dir, 'w.txt'), (mtime) => seen.push(mtime), 20);
    try {
      await wait(150);
      rmSync(join(dir, 'w.txt'));
      await wait(400);
      expect(seen).toEqual([null]);
      writeFileSync(join(dir, 'w.txt'), 'two');
      await wait(400);
      expect(seen.length).toBe(2);
      expect(typeof seen[1]).toBe('number');
    } finally {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
