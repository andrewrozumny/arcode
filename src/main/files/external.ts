import { execFile } from 'node:child_process';
import { constants, copyFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import type { ExternalEntry, ExternalPlace, ExternalPreview } from '@shared/files';
import { readAbsoluteFile } from '../viewer/service';
import { isInside, normalizeRel, resolveInside } from './paths';

/** Newest files shown in the Recent place. */
const RECENT_LIMIT = 60;
/** Folders (under home) whose top-level files make up Recent. */
const RECENT_FOLDERS = ['Downloads', 'Desktop', 'Documents'];
/** Preview reads at most this much text and shows at most this many lines. */
export const PREVIEW_TEXT_BYTES = 256 * 1024;
export const PREVIEW_TEXT_LINES = 200;

/** True when `path` is absolute and lies inside `home` (or is `home` itself). */
export function isInsideHome(path: string, home: string): boolean {
  return isAbsolute(path) && isInside(home, path);
}

function assertInsideHome(path: string, home: string): void {
  if (!isInsideHome(path, home)) throw new Error(`Path is outside the home folder: ${path}`);
}

/** Expands a leading `~` and trims; empty input gives null. */
export function expandHomePath(value: string, home: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2));
  return trimmed;
}

/** Folder that macOS saves screenshots to; null when the setting cannot be read. */
export function readScreenshotLocation(home: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('defaults', ['read', 'com.apple.screencapture', 'location'], (error, stdout) => {
      if (error) return resolve(null);
      resolve(expandHomePath(stdout, home));
    });
  });
}

/** The three mandatory quick places of the import dialog, in display order. */
export function resolvePlaces(home: string, screenshotDir: string | null): ExternalPlace[] {
  return [
    { id: 'screenshots', label: 'Screenshots', path: screenshotDir ?? join(home, 'Desktop'), root: home },
    { id: 'downloads', label: 'Downloads', path: join(home, 'Downloads'), root: home },
    { id: 'recent', label: 'Recent', path: null, root: home },
  ];
}

function isVisible(name: string): boolean {
  return !name.startsWith('.');
}

async function fileEntry(dir: string, name: string): Promise<ExternalEntry | null> {
  const path = join(dir, name);
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { name, path, kind: 'file', size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function listRecent(home: string): Promise<ExternalEntry[]> {
  const found: ExternalEntry[] = [];
  for (const folder of RECENT_FOLDERS) {
    const dir = join(home, folder);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter(isVisible)) {
      const entry = await fileEntry(dir, name);
      if (entry) found.push(entry);
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RECENT_LIMIT);
}

/** Entries of a folder outside the project, or of Recent when `path` is null. Files first, then names. */
export async function listExternal(home: string, path: string | null): Promise<ExternalEntry[]> {
  if (path === null) return listRecent(home);
  assertInsideHome(path, home);
  const names = await readdir(path);
  const entries: ExternalEntry[] = [];
  for (const name of names.filter(isVisible)) {
    const full = join(path, name);
    try {
      const info = await stat(full);
      if (info.isDirectory()) {
        entries.push({ name, path: full, kind: 'dir', size: 0, mtimeMs: info.mtimeMs });
      } else if (info.isFile()) {
        entries.push({ name, path: full, kind: 'file', size: info.size, mtimeMs: info.mtimeMs });
      }
    } catch {
      // Broken symlink or a file that vanished while listing: skip it.
    }
  }
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

/** `name.ext` -> `name (2).ext`, `name (3).ext`, ... Returns the first name that `copyFile` can create. */
async function copyWithUniqueName(source: string, destDir: string): Promise<string> {
  const ext = extname(source);
  const base = basename(source, ext);
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    try {
      await copyFile(source, join(destDir, name), constants.COPYFILE_EXCL);
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Copies files from outside the project into `relDir` inside it. Sources may be any absolute
 * existing file (pasted or dropped files come from anywhere, not only from home); the
 * destination goes through resolveInside, so it cannot leave the project.
 */
export async function importFiles(root: string, relDir: string, sources: readonly string[]): Promise<string[]> {
  for (const source of sources) {
    if (!isAbsolute(source)) throw new Error(`Not an absolute path: ${source}`);
    const info = await stat(source);
    if (!info.isFile()) throw new Error(`Only files can be imported: ${source}`);
  }
  const destDir = await resolveInside(root, relDir);
  const destInfo = await stat(destDir);
  if (!destInfo.isDirectory()) throw new Error(`Not a folder: ${relDir}`);

  const created: string[] = [];
  for (const source of sources) {
    const name = await copyWithUniqueName(source, destDir);
    created.push(normalizeRel(join(relDir, name)));
  }
  return created;
}

/** First `maxLines` lines of `text`; `truncated` says whether anything was cut. */
export function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

/** Preview of a file under home for the import dialog: image, text head, or a reason for none. */
export async function previewExternal(home: string, path: string): Promise<ExternalPreview> {
  assertInsideHome(path, home);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  const base = { size: info.size, mtimeMs: info.mtimeMs };
  const result = await readAbsoluteFile(path, PREVIEW_TEXT_BYTES);
  switch (result.kind) {
    case 'image':
      return { kind: 'image', dataUrl: result.dataUrl, mime: result.mime, ...base };
    case 'text': {
      const head = truncateLines(result.content, PREVIEW_TEXT_LINES);
      return { kind: 'text', text: head.text, truncated: head.truncated, ...base };
    }
    case 'binary':
    case 'pdf':
      return { kind: 'none', reason: 'No preview for this file type', ...base };
    case 'tooLarge':
      return { kind: 'none', reason: 'Too large to preview', ...base };
    default:
      return { kind: 'none', reason: result.message, ...base };
  }
}
