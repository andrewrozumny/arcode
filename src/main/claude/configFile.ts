import { open } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, sep } from 'node:path';
import type { ConfigFileContent } from '@shared/claude';

/** Larger files are cut; the panel preview is for reading a skill or agent, not for big documents. */
export const CONFIG_PREVIEW_BYTES = 256 * 1024;
const PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.json', '.txt']);

function inside(path: string, folder: string): boolean {
  const base = folder.endsWith(sep) ? folder : `${folder}${sep}`;
  return path.startsWith(base);
}

/**
 * Whether the Claude panel may preview a file: an absolute, already normalised path to a Markdown,
 * JSON or text file under `~/.claude` (skills, agents, plugins, the global CLAUDE.md) or under the
 * project. Paths are compared as given, so a skill folder symlinked into `~/.claude/skills` previews
 * the way Claude Code reads it. Nothing outside those two folders is readable this way.
 */
export function configFileAllowed(path: string, root: string, home: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  if (!PREVIEW_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  return inside(path, join(home, '.claude')) || inside(path, root);
}

/** Reads a previewable config file, at most CONFIG_PREVIEW_BYTES. Never writes. */
export async function readConfigFile(root: string, path: string, home: string): Promise<ConfigFileContent> {
  if (!configFileAllowed(path, root, home)) return { ok: false, reason: 'This file cannot be previewed here.' };
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { ok: false, reason: 'File not found.' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'Not a file.' };
    const length = Math.min(info.size, CONFIG_PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: info.size > length };
  } catch {
    return { ok: false, reason: 'File could not be read.' };
  } finally {
    await handle.close();
  }
}
