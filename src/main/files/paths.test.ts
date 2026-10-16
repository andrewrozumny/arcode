import { mkdtemp, mkdir, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeRel, resolveEntryInside, resolveInside } from './paths';

describe('normalizeRel', () => {
  it('normalizes separators and dots', () => {
    expect(normalizeRel('./a//b/./c/')).toBe('a/b/c');
    expect(normalizeRel('')).toBe('');
    expect(normalizeRel('a/b/../c')).toBe('a/c');
  });
  it('rejects escapes and absolute paths', () => {
    expect(() => normalizeRel('../x')).toThrow();
    expect(() => normalizeRel('a/../../x')).toThrow();
    expect(() => normalizeRel('/etc/passwd')).toThrow();
    expect(() => normalizeRel('a\0b')).toThrow();
  });
});

describe('resolveInside', () => {
  let root: string;
  let outside: string;
  beforeAll(async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'acode-paths-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'x');
    await mkdir(join(root, 'src'));
    await symlink(outside, join(root, 'link-out'));
    await symlink(join(root, 'src'), join(root, 'link-in'));
  });

  it('accepts paths inside the root, existing or not', async () => {
    expect(await resolveInside(root, '')).toBe(root);
    expect(await resolveInside(root, 'src')).toBe(join(root, 'src'));
    expect(await resolveInside(root, 'src/new/file.ts')).toBe(join(root, 'src/new/file.ts'));
    expect(await resolveInside(root, 'link-in')).toBe(join(root, 'link-in'));
  });
  it('rejects ../ and absolute paths', async () => {
    await expect(resolveInside(root, '../outside')).rejects.toThrow();
    await expect(resolveInside(root, 'src/../../outside')).rejects.toThrow();
    await expect(resolveInside(root, outside)).rejects.toThrow();
  });
  it('does not treat a sibling folder with a common prefix as inside', async () => {
    await expect(resolveInside(root, '../root-evil/x')).rejects.toThrow();
  });
  it('rejects symlinks pointing outside', async () => {
    await expect(resolveInside(root, 'link-out')).rejects.toThrow();
    await expect(resolveInside(root, 'link-out/secret.txt')).rejects.toThrow();
    await expect(resolveInside(root, 'link-out/new.txt')).rejects.toThrow();
  });
});

describe('resolveEntryInside', () => {
  it('accepts a symlink that lives in the project even when it points outside', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'acode-entry-')));
    const root = join(base, 'root');
    await mkdir(root);
    await mkdir(join(base, 'outside'));
    await symlink(join(base, 'outside'), join(root, 'link-out'));
    expect(await resolveEntryInside(root, 'link-out')).toBe(join(root, 'link-out'));
    await expect(resolveEntryInside(root, 'link-out/secret.txt')).rejects.toThrow();
    await expect(resolveEntryInside(root, '')).rejects.toThrow();
    await expect(resolveEntryInside(root, '../outside')).rejects.toThrow();
  });
});
