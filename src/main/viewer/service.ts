import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { open, readFile as fsReadFile, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { IMAGE_SIZE_LIMIT, TEXT_SIZE_LIMIT } from '@shared/viewer';
import type { ReadFileResult, WriteFileResult } from '@shared/viewer';
import { resolveInside } from '../files/paths';

const BINARY_SNIFF_BYTES = 8 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** A buffer is treated as binary when its first 8 KB contain a NUL byte. */
export function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}

export function imageMime(path: string): string | null {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null;
}

async function sniff(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readFile(root: string, relPath: string): Promise<ReadFileResult> {
  try {
    return await readAbsoluteFile(await resolveInside(root, relPath));
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reads an absolute path the caller has already authorised: images as data URLs, text as a
 * string, binaries and oversized files flagged. `textLimit` caps text reads (default: the viewer's).
 */
export async function readAbsoluteFile(abs: string, textLimit: number = TEXT_SIZE_LIMIT): Promise<ReadFileResult> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { kind: 'error', message: 'Not a regular file' };
    const mime = imageMime(abs);
    if (mime) {
      if (info.size > IMAGE_SIZE_LIMIT) return { kind: 'tooLarge', size: info.size };
      const data = await fsReadFile(abs);
      return {
        kind: 'image',
        dataUrl: `data:${mime};base64,${data.toString('base64')}`,
        mime,
        size: info.size,
        mtime: info.mtimeMs,
        ...(mime === 'image/svg+xml' ? { svgSource: data.toString('utf-8') } : {}),
      };
    }
    if (looksBinary(await sniff(abs))) return { kind: 'binary', size: info.size };
    if (info.size > textLimit) return { kind: 'tooLarge', size: info.size };
    const content = (await fsReadFile(abs)).toString('utf-8');
    return { kind: 'text', content, encoding: 'utf-8', size: info.size, mtime: info.mtimeMs };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeFile(
  root: string,
  relPath: string,
  content: string,
  expectedMtime: number | null,
): Promise<WriteFileResult> {
  try {
    const abs = await resolveInside(root, relPath);
    let current: number | null = null;
    try {
      current = (await stat(abs)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current !== expectedMtime) return { ok: false, reason: 'conflict', mtime: current };
    await fsWriteFile(abs, content, 'utf-8');
    return { ok: true, mtime: (await stat(abs)).mtimeMs };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** `git show HEAD:<path>`; null when the file is not in HEAD or the folder is not a git repo. */
export async function headContent(root: string, relPath: string): Promise<string | null> {
  let abs: string;
  try {
    abs = await resolveInside(root, relPath);
  } catch {
    return null;
  }
  return new Promise((done) => {
    const posixRel = relative(resolve(root), abs).split(sep).join('/');
    execFile(
      'git',
      ['show', `HEAD:./${posixRel}`],
      { cwd: resolve(root), maxBuffer: 32 * 1024 * 1024, encoding: 'utf-8' },
      (error, stdout) => done(error ? null : stdout),
    );
  });
}

/**
 * Watches one file (an absolute path the caller has already checked) and reports its new mtime,
 * or null when removed, debounced. Editors that save through rename replace the inode, so the
 * watcher re-attaches.
 */
export function watchFile(abs: string, onChange: (mtime: number | null) => void, debounceMs = 120): () => void {
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastMtime: number | null | undefined;
  let disposed = false;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void check(), debounceMs);
  };

  const attach = (): void => {
    watcher?.close();
    watcher = null;
    try {
      watcher = watch(abs, schedule);
      watcher.on('error', schedule);
    } catch {
      // File missing right now: watch its folder so the file coming back is noticed.
      try {
        const name = basename(abs);
        watcher = watch(dirname(abs), (_event, filename) => {
          if (filename === null || filename.toString() === name) schedule();
        });
        watcher.on('error', () => undefined);
      } catch {
        // The folder is gone too; nothing left to watch.
      }
    }
  };

  const check = async (): Promise<void> => {
    if (disposed) return;
    let mtime: number | null = null;
    try {
      mtime = (await stat(abs)).mtimeMs;
    } catch {
      mtime = null;
    }
    // Disposed while stat was running: attaching now would leak a watcher nobody closes.
    if (disposed) return;
    attach();
    if (disposed || mtime === lastMtime) return;
    lastMtime = mtime;
    onChange(mtime);
  };

  void stat(abs)
    .then((info) => {
      lastMtime = info.mtimeMs;
    })
    .catch(() => {
      lastMtime = null;
    })
    .finally(() => {
      if (!disposed) attach();
    });

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
