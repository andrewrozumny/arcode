import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changedSpan,
  encodeRelPath,
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_PER_FILE,
  isLargeChange,
  LocalHistory,
  parseSnapshotName,
  projectKey,
  relInside,
  SAVE_SNAPSHOT_INTERVAL_MS,
  shouldSnapshot,
  snapshotName,
} from './history';
import { writeFile } from './service';

const MIN = 60 * 1000;

describe('path encoding', () => {
  it('turns a relative path into one flat folder name', () => {
    expect(encodeRelPath('src/main/index.ts')).toBe('src%2Fmain%2Findex.ts');
    expect(encodeRelPath('./src//a b.ts')).toBe('src%2Fa%20b.ts');
    expect(decodeURIComponent(encodeRelPath('docs/notes ü.md'))).toBe('docs/notes ü.md');
  });

  it('refuses paths that leave the project and the root itself', () => {
    expect(() => encodeRelPath('../etc/passwd')).toThrow();
    expect(() => encodeRelPath('/etc/passwd')).toThrow();
    expect(() => encodeRelPath('')).toThrow();
  });

  it('shortens very long paths and keeps them apart with a hash', () => {
    const a = encodeRelPath(`${'deep/'.repeat(60)}a.ts`);
    const b = encodeRelPath(`${'deep/'.repeat(60)}b.ts`);
    expect(a.length).toBeLessThan(200);
    expect(a).not.toBe(b);
    expect(a).not.toContain('/');
  });

  it('keys projects by their resolved root', () => {
    expect(projectKey('/tmp/p')).toBe(projectKey('/tmp/p/'));
    expect(projectKey('/tmp/p')).not.toBe(projectKey('/tmp/q'));
  });

  it('only accepts files inside the root', () => {
    expect(relInside('/work/app', '/work/app/src/a.ts')).toBe('src/a.ts');
    expect(() => relInside('/work/app', '/work/application/a.ts')).toThrow();
    expect(() => relInside('/work/app', '/work/other/a.ts')).toThrow();
    expect(() => relInside('/work/app', '/work/app')).toThrow();
  });

  it('round-trips snapshot names and rejects anything else', () => {
    expect(parseSnapshotName(snapshotName(1700000000000, 'external'))).toEqual({ timestamp: 1700000000000, source: 'external' });
    expect(parseSnapshotName('../1700000000000-save.txt')).toBeNull();
    expect(parseSnapshotName('1700000000000-other.txt')).toBeNull();
  });
});

describe('snapshot decisions', () => {
  const newest = { timestamp: 1000, source: 'save' as const, content: 'hello world' };

  it('measures the changed middle part', () => {
    expect(changedSpan('abcdef', 'abcdef')).toBe(0);
    expect(changedSpan('abcdef', 'abXYef')).toBe(2);
    expect(changedSpan('abc', 'abcdef')).toBe(3);
    expect(isLargeChange('a'.repeat(10), 'b'.repeat(10))).toBe(false);
    expect(isLargeChange('a'.repeat(1000), 'b'.repeat(1000))).toBe(true);
    expect(isLargeChange('a'.repeat(10000), `${'a'.repeat(9000)}${'b'.repeat(1000)}`)).toBe(false);
    expect(isLargeChange('a'.repeat(10000), 'b'.repeat(2500))).toBe(true);
  });

  it('takes the first snapshot and never repeats identical content', () => {
    expect(shouldSnapshot({ newest: null, content: 'x', source: 'save', now: 0 })).toBe(true);
    expect(shouldSnapshot({ newest, content: newest.content, source: 'external', now: 1e9 })).toBe(false);
    expect(shouldSnapshot({ newest, content: newest.content, source: 'save', now: 1e9, force: true })).toBe(false);
  });

  it('throttles saves but not outside changes or restores', () => {
    const soon = newest.timestamp + MIN;
    expect(shouldSnapshot({ newest, content: 'hello world!', source: 'save', now: soon })).toBe(false);
    expect(shouldSnapshot({ newest, content: 'hello world!', source: 'external', now: soon })).toBe(true);
    expect(shouldSnapshot({ newest, content: 'hello world!', source: 'save', now: soon, force: true })).toBe(true);
    expect(
      shouldSnapshot({ newest, content: 'hello world!', source: 'save', now: newest.timestamp + SAVE_SNAPSHOT_INTERVAL_MS }),
    ).toBe(true);
  });

  it('keeps a save right after an outside change and after a large edit', () => {
    const soon = newest.timestamp + MIN;
    expect(shouldSnapshot({ newest: { ...newest, source: 'external' }, content: 'other', source: 'save', now: soon })).toBe(true);
    expect(shouldSnapshot({ newest, content: 'z'.repeat(3000), source: 'save', now: soon })).toBe(true);
  });
});

describe('LocalHistory', () => {
  let tmp: string;
  let root: string;
  let base: string;
  let clock: number;
  let history: LocalHistory;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'arcode-history-'));
    root = join(tmp, 'project');
    base = join(tmp, 'userData', 'history');
    mkdirSync(join(root, 'src'), { recursive: true });
    clock = 1_700_000_000_000;
    history = new LocalHistory(base, () => clock);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const file = (rel: string): string => join(root, rel);
  const mtime = (abs: string): number => statSync(abs).mtimeMs;

  it('keeps the previous content before a save, throttled for autosave', async () => {
    const abs = file('src/a.ts');
    writeFileSync(abs, 'v1');
    await writeFile(root, 'src/a.ts', 'v2', mtime(abs), history.writeHooks(root));
    clock += 1000;
    await writeFile(root, 'src/a.ts', 'v3', mtime(abs), history.writeHooks(root));
    clock += SAVE_SNAPSHOT_INTERVAL_MS;
    await writeFile(root, 'src/a.ts', 'v4', mtime(abs), history.writeHooks(root));

    const list = await history.list(root, abs);
    expect(list.map((s) => s.source)).toEqual(['save', 'save']);
    expect(await history.read(root, abs, list[1]?.id ?? '')).toBe('v1');
    expect(await history.read(root, abs, list[0]?.id ?? '')).toBe('v3');
    expect(list[0]?.size).toBe(2);
    expect(readFileSync(abs, 'utf-8')).toBe('v4');
  });

  it('stores folders under the project key and the encoded path', async () => {
    const abs = file('src/a.ts');
    writeFileSync(abs, 'v1');
    await history.snapshot(root, abs, 'v1', 'save');
    expect(readdirSync(join(base, projectKey(root)))).toEqual(['src%2Fa.ts']);
  });

  it('keeps the known content when a watched file changes from outside, and ignores our own saves', async () => {
    const abs = file('src/b.ts');
    writeFileSync(abs, 'original');
    await history.prime(abs);

    // Our save: the snapshot is the pre-save content, and the watcher event that follows is ignored.
    await writeFile(root, 'src/b.ts', 'mine', mtime(abs), history.writeHooks(root));
    expect(await history.externalChange(root, abs)).toBe(false);

    clock += 1000;
    writeFileSync(abs, 'claude');
    expect(await history.externalChange(root, abs)).toBe(true);
    // A second window watching the same file reports the same change.
    expect(await history.externalChange(root, abs)).toBe(false);

    const list = await history.list(root, abs);
    expect(list.map((s) => s.source)).toEqual(['external', 'save']);
    expect(await history.read(root, abs, list[0]?.id ?? '')).toBe('mine');

    // Deleted from outside: the last content is kept too.
    clock += 1000;
    rmSync(abs);
    expect(await history.externalChange(root, abs)).toBe(true);
    const after = await history.list(root, abs);
    expect(await history.read(root, abs, after[0]?.id ?? '')).toBe('claude');
  });

  it('dedupes identical consecutive snapshots', async () => {
    const abs = file('c.txt');
    expect(await history.snapshot(root, abs, 'same', 'external')).toBe(true);
    clock += 1000;
    expect(await history.snapshot(root, abs, 'same', 'external')).toBe(false);
    // Same content again from a fresh instance (cache rebuilt from disk).
    const fresh = new LocalHistory(base, () => clock + SAVE_SNAPSHOT_INTERVAL_MS);
    expect(await fresh.snapshot(root, abs, 'same', 'save')).toBe(false);
    expect(await history.list(root, abs)).toHaveLength(1);
  });

  it('skips binary and oversized files', async () => {
    const bin = file('img.bin');
    writeFileSync(bin, Buffer.from([1, 0, 2, 3]));
    await writeFile(root, 'img.bin', 'text', mtime(bin), history.writeHooks(root));
    expect(await history.list(root, bin)).toHaveLength(0);

    const big = file('big.txt');
    expect(await history.snapshot(root, big, 'x'.repeat(HISTORY_MAX_BYTES + 1), 'external')).toBe(false);
  });

  it('caps the number of snapshots per file', async () => {
    const abs = file('d.txt');
    for (let i = 0; i < HISTORY_MAX_PER_FILE + 5; i++) {
      clock += 1000;
      await history.snapshot(root, abs, `v${i}`, 'external');
    }
    const list = await history.list(root, abs);
    expect(list).toHaveLength(HISTORY_MAX_PER_FILE);
    expect(await history.read(root, abs, list[0]?.id ?? '')).toBe(`v${HISTORY_MAX_PER_FILE + 4}`);
  });

  it('prunes snapshots older than the retention and empty folders at startup', async () => {
    const old = file('old.txt');
    const recent = file('recent.txt');
    await history.snapshot(root, old, 'old', 'external');
    clock += HISTORY_MAX_AGE_MS - MIN;
    await history.snapshot(root, recent, 'recent', 'external');
    clock += 2 * MIN;
    expect(await history.prune()).toBe(1);
    expect(await history.list(root, old)).toHaveLength(0);
    expect(await history.list(root, recent)).toHaveLength(1);
    expect(readdirSync(join(base, projectKey(root)))).toEqual(['recent.txt']);
  });

  it('refuses files outside the project and malformed snapshot ids', async () => {
    const outside = join(tmp, 'elsewhere.txt');
    await expect(history.snapshot(root, outside, 'x', 'save')).rejects.toThrow(/outside/);
    await expect(history.list(root, outside)).rejects.toThrow(/outside/);
    expect(await history.externalChange(root, outside)).toBe(false);
    await expect(history.read(root, file('a.txt'), '../../state.json')).rejects.toThrow(/Invalid snapshot/);
    expect(readdirSync(tmp).includes('userData')).toBe(false);
  });
});
