import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserWindow } from 'electron';
import { findEnclosingRepo, OpenRequestRouter, pathsFromArgv, pickWindowRoot } from './openRequests';

describe('pickWindowRoot', () => {
  const roots = ['/work/app', '/work/app/packages/web', '/other'];

  it('prefers the longest root containing the path', () => {
    expect(pickWindowRoot('/work/app/packages/web/src/a.ts', roots)).toBe('/work/app/packages/web');
    expect(pickWindowRoot('/work/app/README.md', roots)).toBe('/work/app');
  });

  it('matches the root itself and rejects sibling prefixes', () => {
    expect(pickWindowRoot('/work/app', roots)).toBe('/work/app');
    expect(pickWindowRoot('/work/app2/x.ts', roots)).toBeNull();
    expect(pickWindowRoot('/elsewhere/x.ts', roots)).toBeNull();
  });
});

describe('findEnclosingRepo', () => {
  it('walks up to the folder that holds .git and stops at the filesystem root', () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-open-'));
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(findEnclosingRepo(join(repo, 'src', 'deep'))).toBe(repo);
    expect(findEnclosingRepo(repo)).toBe(repo);
    expect(findEnclosingRepo('/nonexistent/x/y', () => false)).toBeNull();
  });
});

describe('pathsFromArgv', () => {
  it('keeps existing paths, resolves relative ones and drops flags', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'acode-argv-'));
    writeFileSync(join(dir, 'a.txt'), '');
    const out = pathsFromArgv(['/Applications/ARcode.app/Contents/MacOS/ARcode', '--no-sandbox', 'a.txt', 'missing.txt'], dir);
    expect(out).toEqual([join(dir, 'a.txt')]);
  });
});

describe('OpenRequestRouter', () => {
  it('opens a folder given with a trailing slash or dot segments under its normalized path', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'acode-route-'));
    mkdirSync(join(dir, 'sub'));
    const opened: string[] = [];
    const router = new OpenRequestRouter();
    router.attach({
      roots: () => [],
      openProject: (root) => {
        opened.push(root);
        return {} as BrowserWindow;
      },
    });
    router.open(`${dir}/`);
    router.open(`${dir}/sub/..`);
    expect(opened).toEqual([dir, dir]);
  });
});
