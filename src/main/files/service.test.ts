import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyFileOp, compareEntries, listDir } from './service';

async function populate(root: string): Promise<void> {
  await mkdir(join(root, 'Zeta'));
  await mkdir(join(root, 'alpha'));
  await mkdir(join(root, 'node_modules'));
  await mkdir(join(root, 'logs'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'b.txt'), '');
  await writeFile(join(root, 'A.txt'), '');
  await writeFile(join(root, '.gitignore'), 'logs/\n*.log\ndist/\n');
  await writeFile(join(root, 'debug.log'), '');
  await writeFile(join(root, 'alpha', 'inner.ts'), '');
  await writeFile(join(root, 'alpha', '.gitignore'), 'local.txt\n');
  await writeFile(join(root, 'alpha', 'local.txt'), '');
  await symlink(join(root, 'b.txt'), join(root, 'link'));
}

describe('compareEntries', () => {
  it('puts folders first and sorts case-insensitively', () => {
    const list = [
      { name: 'b.txt', kind: 'file' as const },
      { name: 'Zeta', kind: 'dir' as const },
      { name: 'A.txt', kind: 'file' as const },
      { name: 'alpha', kind: 'dir' as const },
    ];
    list.sort(compareEntries);
    expect(list.map((e) => e.name)).toEqual(['alpha', 'Zeta', 'A.txt', 'b.txt']);
  });
});

describe('listDir in a git repo', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'acode-svc-git-'));
    await populate(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
  });

  it('sorts, flags ignored and heavy entries, detects symlinks', async () => {
    const entries = await listDir(root, '');
    expect(entries.map((e) => e.name)).toEqual([
      '.git',
      'alpha',
      'dist',
      'logs',
      'node_modules',
      'Zeta',
      '.gitignore',
      'A.txt',
      'b.txt',
      'debug.log',
      'link',
    ]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.logs?.ignored).toBe(true);
    expect(byName['debug.log']?.ignored).toBe(true);
    expect(byName.dist).toMatchObject({ ignored: true, heavy: true });
    expect(byName.node_modules?.heavy).toBe(true);
    expect(byName['A.txt']?.ignored).toBe(false);
    expect(byName.link?.kind).toBe('symlink');
  });

  it('honors nested .gitignore', async () => {
    const entries = await listDir(root, 'alpha');
    expect(entries.find((e) => e.name === 'local.txt')?.ignored).toBe(true);
    expect(entries.find((e) => e.name === 'inner.ts')?.ignored).toBe(false);
  });

  it('rejects traversal', async () => {
    await expect(listDir(root, '../')).rejects.toThrow();
  });
});

describe('listDir outside git (ignore package fallback)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'acode-svc-plain-'));
    await populate(root);
  });

  it('applies root and nested .gitignore', async () => {
    const entries = await listDir(root, '');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.logs?.ignored).toBe(true);
    expect(byName['debug.log']?.ignored).toBe(true);
    expect(byName['A.txt']?.ignored).toBe(false);
    const nested = await listDir(root, 'alpha');
    expect(nested.find((e) => e.name === 'local.txt')?.ignored).toBe(true);
  });
});

describe('applyFileOp', () => {
  it('creates, renames and refuses to overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acode-ops-'));
    await applyFileOp(root, { type: 'createFile', relPath: 'a/b/c.txt' });
    expect(await readFile(join(root, 'a/b/c.txt'), 'utf8')).toBe('');
    await expect(applyFileOp(root, { type: 'createFile', relPath: 'a/b/c.txt' })).rejects.toThrow();
    await applyFileOp(root, { type: 'createDir', relPath: 'd' });
    await applyFileOp(root, { type: 'rename', relPath: 'a/b/c.txt', newRelPath: 'd/e.txt' });
    expect(await readFile(join(root, 'd/e.txt'), 'utf8')).toBe('');
    await applyFileOp(root, { type: 'createFile', relPath: 'x.txt' });
    await expect(applyFileOp(root, { type: 'rename', relPath: 'x.txt', newRelPath: 'd/e.txt' })).rejects.toThrow();
    await expect(applyFileOp(root, { type: 'createFile', relPath: '../evil' })).rejects.toThrow();
  });

  it('renames a symlink that points outside the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acode-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'acode-link-out-'));
    await symlink(outside, join(root, 'shared'));
    await applyFileOp(root, { type: 'rename', relPath: 'shared', newRelPath: 'shared-docs' });
    expect(await readdir(root)).toEqual(['shared-docs']);
  });

  it('renames a file to a different letter case on a case-insensitive volume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acode-case-'));
    await writeFile(join(root, 'readme.md'), 'x');
    await applyFileOp(root, { type: 'rename', relPath: 'readme.md', newRelPath: 'README.md' });
    expect(await readdir(root)).toEqual(['README.md']);
  });
});
