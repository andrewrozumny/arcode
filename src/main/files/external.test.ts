import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandHomePath,
  importFiles,
  isInsideHome,
  listExternal,
  previewExternal,
  resolvePlaces,
  truncateLines,
  PREVIEW_TEXT_LINES,
} from './external';

function makeHome(): string {
  const home = mkdtempSync(join(os.tmpdir(), 'acode-ext-home-'));
  for (const folder of ['Downloads', 'Desktop', 'Documents', 'Shots']) mkdirSync(join(home, folder));
  return home;
}

function makeProject(): string {
  return mkdtempSync(join(os.tmpdir(), 'acode-ext-project-'));
}

describe('resolvePlaces', () => {
  it('returns Screenshots, Downloads and Recent in that order', () => {
    const places = resolvePlaces('/Users/me', '/Users/me/Shots');
    expect(places.map((p) => [p.id, p.label, p.path])).toEqual([
      ['screenshots', 'Screenshots', '/Users/me/Shots'],
      ['downloads', 'Downloads', '/Users/me/Downloads'],
      ['recent', 'Recent', null],
    ]);
  });

  it('falls back to Desktop when the screenshot location is unknown', () => {
    expect(resolvePlaces('/Users/me', null)[0]?.path).toBe('/Users/me/Desktop');
  });

  it('bounds every place by the home folder', () => {
    expect(resolvePlaces('/Users/me', null).every((p) => p.root === '/Users/me')).toBe(true);
  });
});

describe('expandHomePath', () => {
  it('expands ~ and trims; empty input gives null', () => {
    expect(expandHomePath(' ~/Pictures/Shots \n', '/Users/me')).toBe('/Users/me/Pictures/Shots');
    expect(expandHomePath('/tmp/x', '/Users/me')).toBe('/tmp/x');
    expect(expandHomePath('  \n', '/Users/me')).toBeNull();
  });
});

describe('isInsideHome', () => {
  it('accepts home and paths below it, rejects everything else', () => {
    expect(isInsideHome('/Users/me', '/Users/me')).toBe(true);
    expect(isInsideHome('/Users/me/Downloads/a.png', '/Users/me')).toBe(true);
    expect(isInsideHome('/Users/me/../other/a.png', '/Users/me')).toBe(false);
    expect(isInsideHome('/Users/meextra/a.png', '/Users/me')).toBe(false);
    expect(isInsideHome('relative/a.png', '/Users/me')).toBe(false);
  });
});

describe('listExternal', () => {
  it('lists files first, skips hidden files and sorts by name', async () => {
    const home = makeHome();
    const dir = join(home, 'Downloads');
    writeFileSync(join(dir, 'b.png'), 'b');
    writeFileSync(join(dir, 'A.png'), 'a');
    writeFileSync(join(dir, '.DS_Store'), 'x');
    mkdirSync(join(dir, 'sub'));
    const entries = await listExternal(home, dir);
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['A.png', 'file'],
      ['b.png', 'file'],
      ['sub', 'dir'],
    ]);
    expect(entries[0]?.size).toBe(1);
  });

  it('refuses folders outside home', async () => {
    const home = makeHome();
    await expect(listExternal(home, '/etc')).rejects.toThrow('outside the home folder');
  });

  it('Recent lists the newest top-level files across the three folders, capped', async () => {
    const home = makeHome();
    const old = join(home, 'Documents', 'old.pdf');
    const fresh = join(home, 'Desktop', 'fresh.png');
    writeFileSync(old, 'o');
    writeFileSync(fresh, 'f');
    writeFileSync(join(home, 'Downloads', '.hidden'), 'h');
    mkdirSync(join(home, 'Downloads', 'nested'));
    writeFileSync(join(home, 'Downloads', 'nested', 'deep.txt'), 'd');
    utimesSync(old, 1_000, 1_000);
    utimesSync(fresh, 2_000, 2_000);
    const entries = await listExternal(home, null);
    expect(entries.map((e) => e.name)).toEqual(['fresh.png', 'old.pdf']);
  });
});

describe('importFiles', () => {
  it('copies files into the folder and keeps the name when free', async () => {
    const home = makeHome();
    const project = makeProject();
    mkdirSync(join(project, 'incoming'));
    const src = join(home, 'Downloads', 'spec.pdf');
    writeFileSync(src, 'pdf');
    const created = await importFiles(project, 'incoming', [src]);
    expect(created).toEqual(['incoming/spec.pdf']);
    expect(readFileSync(join(project, 'incoming', 'spec.pdf'), 'utf8')).toBe('pdf');
  });

  it('adds " (2)", " (3)" before the extension on name collisions', async () => {
    const home = makeHome();
    const project = makeProject();
    mkdirSync(join(project, 'incoming'));
    writeFileSync(join(project, 'incoming', 'shot.png'), 'existing');
    const src = join(home, 'Desktop', 'shot.png');
    writeFileSync(src, 'new');
    const first = await importFiles(project, 'incoming', [src]);
    const second = await importFiles(project, 'incoming', [src]);
    expect(first).toEqual(['incoming/shot (2).png']);
    expect(second).toEqual(['incoming/shot (3).png']);
    expect(readFileSync(join(project, 'incoming', 'shot.png'), 'utf8')).toBe('existing');
  });

  it('imports into the project root with an empty relDir', async () => {
    const home = makeHome();
    const project = makeProject();
    const src = join(home, 'Desktop', 'a.txt');
    writeFileSync(src, 'a');
    expect(await importFiles(project, '', [src])).toEqual(['a.txt']);
  });

  it('accepts sources outside home (pasted or dropped files come from anywhere)', async () => {
    const project = makeProject();
    const outside = mkdtempSync(join(os.tmpdir(), 'acode-ext-outside-'));
    const src = join(outside, 'note.txt');
    writeFileSync(src, 'n');
    expect(await importFiles(project, '', [src])).toEqual(['note.txt']);
  });

  it('rejects relative sources', async () => {
    const project = makeProject();
    await expect(importFiles(project, '', ['note.txt'])).rejects.toThrow('Not an absolute path');
  });

  it('rejects directories as sources', async () => {
    const home = makeHome();
    const project = makeProject();
    await expect(importFiles(project, '', [join(home, 'Downloads')])).rejects.toThrow('Only files');
  });

  it('rejects destinations that leave the project', async () => {
    const home = makeHome();
    const project = makeProject();
    const src = join(home, 'Desktop', 'a.txt');
    writeFileSync(src, 'a');
    await expect(importFiles(project, '../escape', [src])).rejects.toThrow('escapes the project root');
  });
});

describe('truncateLines', () => {
  it('keeps short text whole and cuts long text to the limit', () => {
    expect(truncateLines('a\nb', 5)).toEqual({ text: 'a\nb', truncated: false });
    expect(truncateLines('a\nb\nc\nd', 2)).toEqual({ text: 'a\nb', truncated: true });
  });
});

describe('previewExternal', () => {
  // 1x1 transparent PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  it('returns a data URL for images', async () => {
    const home = makeHome();
    const file = join(home, 'Downloads', 'dot.png');
    writeFileSync(file, png);
    const preview = await previewExternal(home, file);
    expect(preview.kind).toBe('image');
    if (preview.kind === 'image') {
      expect(preview.mime).toBe('image/png');
      expect(preview.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      expect(preview.size).toBe(png.length);
    }
  });

  it('returns the head of a text file and flags truncation', async () => {
    const home = makeHome();
    const file = join(home, 'Documents', 'notes.txt');
    const lines = Array.from({ length: PREVIEW_TEXT_LINES + 5 }, (_, i) => `line ${i}`);
    writeFileSync(file, lines.join('\n'));
    const preview = await previewExternal(home, file);
    expect(preview.kind).toBe('text');
    if (preview.kind === 'text') {
      expect(preview.truncated).toBe(true);
      expect(preview.text.split('\n')).toHaveLength(PREVIEW_TEXT_LINES);
      expect(preview.text.startsWith('line 0\n')).toBe(true);
    }
  });

  it('gives a reason instead of content for binaries', async () => {
    const home = makeHome();
    const file = join(home, 'Downloads', 'blob.bin');
    writeFileSync(file, Buffer.from([0, 1, 2, 3, 0, 0]));
    const preview = await previewExternal(home, file);
    expect(preview.kind).toBe('none');
  });

  it('refuses paths outside home and folders', async () => {
    const home = makeHome();
    await expect(previewExternal(home, '/etc/hosts')).rejects.toThrow(/outside the home folder/);
    await expect(previewExternal(home, join(home, 'Downloads'))).rejects.toThrow(/Not a regular file/);
  });
});
