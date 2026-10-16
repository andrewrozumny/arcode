import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyWatchPath, watchProject } from './watcher';

describe('classifyWatchPath', () => {
  it('ignores heavy folders at any depth', () => {
    expect(classifyWatchPath('node_modules/x/y.js')).toBeNull();
    expect(classifyWatchPath('packages/a/node_modules/x')).toBeNull();
    expect(classifyWatchPath('dist/app.js')).toBeNull();
    expect(classifyWatchPath('.next/cache/a')).toBeNull();
  });
  it('lets only git state files through', () => {
    expect(classifyWatchPath('.git/index')).toBe('git');
    expect(classifyWatchPath('.git/HEAD')).toBe('git');
    expect(classifyWatchPath('.git/refs/heads/main')).toBe('git');
    expect(classifyWatchPath('.git/objects/ab/cdef')).toBeNull();
    expect(classifyWatchPath('.git/index.lock')).toBeNull();
  });
  it('passes ordinary files', () => {
    expect(classifyWatchPath('src/a.ts')).toBe('project');
  });
});

describe('watchProject', () => {
  it('flushes during a steady stream of writes instead of waiting for silence', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'acode-watch-')));
    let batches = 0;
    const watcher = watchProject(root, { debounceMs: 300, maxWaitMs: 500, onBatch: () => batches++ });
    try {
      await new Promise((done) => setTimeout(done, 100));
      const started = Date.now();
      let i = 0;
      while (Date.now() - started < 1200) {
        writeFileSync(join(root, 'log.txt'), `line ${i++}\n`);
        await new Promise((done) => setTimeout(done, 30));
      }
      // Still writing: a trailing-only debounce would not have flushed even once.
      expect(batches).toBeGreaterThan(0);
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
