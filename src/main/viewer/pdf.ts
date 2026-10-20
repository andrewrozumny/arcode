/**
 * PDF documents for the viewer. The renderer shows a PDF in an iframe whose URL uses the
 * privileged `arcode-pdf:` scheme; this module builds those URLs and decides, for each request,
 * which file (if any) may be served. No Electron imports, so it runs in Vitest.
 *
 * URL shape: `arcode-pdf://doc/<project-relative path>?root=<project root>&v=<mtime>`.
 * A request is served only when the root is one of the open project roots, the path passes the
 * one path guard (`files/paths.ts`: no `..`, no absolute path, no symlink out of the root), the
 * name ends in `.pdf` and the bytes start with a PDF header.
 */
import { open, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { normalizeRel, resolveInside } from '../files/paths';

export const PDF_SCHEME = 'arcode-pdf';
const PDF_HOST = 'doc';
export const PDF_MIME = 'application/pdf';
/** The PDF header may follow some junk; readers accept it within the first 1 KB. */
const HEADER_WINDOW = 1024;

export function isPdfPath(path: string): boolean {
  return extname(path).toLowerCase() === '.pdf';
}

/** The viewer URL for a PDF inside `root`. `mtime` busts the cache after a change on disk. */
export function pdfUrl(root: string, relPath: string, mtime: number): string {
  const segments = normalizeRel(relPath).split('/').map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ root, v: String(Math.round(mtime)) });
  return `${PDF_SCHEME}://${PDF_HOST}/${segments}?${query.toString()}`;
}

/** Root and relative path named by a viewer URL, or null when it is not one. */
export function parsePdfUrl(url: string): { root: string; relPath: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PDF_SCHEME}:` || parsed.host !== PDF_HOST) return null;
  const root = parsed.searchParams.get('root');
  if (!root) return null;
  try {
    const relPath = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
    return relPath ? { root, relPath } : null;
  } catch {
    return null;
  }
}

/** True when `bytes` (the start of a file) hold the `%PDF-` header. */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, HEADER_WINDOW)).includes('%PDF-');
}

async function readHead(abs: string): Promise<Buffer> {
  const handle = await open(abs, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_WINDOW);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_WINDOW, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export type PdfTarget =
  | { ok: true; abs: string; size: number }
  | { ok: false; status: 400 | 403 | 404 | 415; message: string };

/** Decides what a `arcode-pdf:` request may read. Never throws. */
export async function resolvePdfRequest(url: string, openRoots: readonly string[]): Promise<PdfTarget> {
  const target = parsePdfUrl(url);
  if (!target) return { ok: false, status: 400, message: 'Not a PDF viewer URL' };
  const { root, relPath } = target;
  if (!isAbsolute(root) || !openRoots.some((open) => resolve(open) === resolve(root))) {
    return { ok: false, status: 403, message: 'Not an open project' };
  }
  if (!isPdfPath(relPath)) return { ok: false, status: 415, message: 'Not a PDF file' };
  let abs: string;
  try {
    abs = await resolveInside(root, relPath);
  } catch (error) {
    return { ok: false, status: 403, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { ok: false, status: 404, message: 'Not a regular file' };
    if (!hasPdfHeader(await readHead(abs))) return { ok: false, status: 415, message: 'Not a PDF file' };
    return { ok: true, abs, size: info.size };
  } catch {
    return { ok: false, status: 404, message: 'File not found' };
  }
}

/** `foo.md` next to `foo.pdf`, as a project-relative path, when it exists. */
export async function markdownSourceFor(root: string, relPath: string): Promise<string | null> {
  try {
    const normalized = normalizeRel(relPath);
    const candidate = `${normalized.slice(0, -extname(normalized).length)}.md`;
    const info = await stat(await resolveInside(root, candidate));
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}
