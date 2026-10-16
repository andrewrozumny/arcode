/**
 * Images pasted into a terminal are saved as files so their path can be typed into Claude Code.
 * They live in the app's data folder (`<userData>/paste`) and are pruned after a week on startup.
 * No Electron imports, so it can be unit tested.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** Pasted images older than this are deleted at startup. */
export const PASTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function pasteDir(userData: string): string {
  return join(userData, 'paste');
}

/** Stores image bytes under `dir` with a random name and returns the absolute file path. */
export async function savePastedImage(dir: string, bytes: unknown, mimeType: unknown): Promise<string> {
  const extension = typeof mimeType === 'string' ? IMAGE_EXTENSIONS[mimeType] : undefined;
  if (!extension) throw new Error(`Unsupported image type: ${String(mimeType)}`);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Invalid image data');
  }
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.${extension}`);
  await writeFile(file, bytes);
  return file;
}

/** Deletes regular files in `dir` last modified before `now - maxAgeMs`. Best effort; returns how many went. */
export async function prunePastedImages(dir: string, maxAgeMs = PASTE_MAX_AGE_MS, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) continue;
      await rm(file, { force: true });
      removed++;
    } catch {
      // Vanished or not removable; try again next start.
    }
  }
  return removed;
}
