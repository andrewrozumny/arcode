/**
 * Where Claude Code keeps session transcripts and how to read them cheaply. Every reader of
 * ~/.claude/projects (sessions list, usage, subagents, the terminal's model badge) goes through
 * here. All file access is async: these run on IPC and timer paths of the main process.
 *
 * Layout: ~/.claude/projects/<slug>/<sessionId>.jsonl, subagents in
 * ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl.
 */
import { access, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './common';

/** Session ids are UUIDs; the pattern also keeps ids from smuggling path segments. */
export const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function projectsDir(home: string): string {
  return join(home, '.claude', 'projects');
}

/** Folder name Claude Code uses under ~/.claude/projects for a project path: every non-alphanumeric becomes '-'. */
export function projectSlug(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Claude Code cuts slugs longer than this and appends a hash of the full path. */
const MAX_SLUG = 200;

/** ~/.claude/projects/<slug> for a project; long paths are matched by the prefix Claude Code keeps. */
export async function projectDir(root: string, home: string): Promise<string> {
  const projects = projectsDir(home);
  const slug = projectSlug(root);
  if (slug.length <= MAX_SLUG) return join(projects, slug);
  const prefix = `${slug.slice(0, MAX_SLUG)}-`;
  try {
    const match = (await readdir(projects)).find((name) => name.startsWith(prefix));
    if (match) return join(projects, match);
  } catch {
    // No projects folder yet.
  }
  return join(projects, slug);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** First `~/.claude/projects/<slug>/<entry>` that exists, searched across slugs (a session id does not name its project). */
async function findInProjects(home: string, entry: string): Promise<string | null> {
  const projects = projectsDir(home);
  let slugs: string[];
  try {
    slugs = await readdir(projects);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const path = join(projects, slug, entry);
    if (await exists(path)) return path;
  }
  return null;
}

/** Path of the session's transcript in whichever project folder holds it, or null. */
export function findSessionTranscript(sessionId: string, home: string): Promise<string | null> {
  return isSessionId(sessionId) ? findInProjects(home, `${sessionId}.jsonl`) : Promise.resolve(null);
}

/** The session's subagents folder, or null when the session has none (yet). */
export function findSubagentsDir(sessionId: string, home: string): Promise<string | null> {
  return isSessionId(sessionId) ? findInProjects(home, join(sessionId, 'subagents')) : Promise.resolve(null);
}

/** Reads up to `length` raw bytes from `start` (fewer at the end of the file). */
export async function readBytes(file: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Reads `length` bytes from `start` as UTF-8. A slice may cut a multi-byte character or a line at either end. */
export async function readSlice(file: string, start: number, length: number): Promise<string> {
  return (await readBytes(file, start, length)).toString('utf8');
}

/** The last `bytes` of a file of `size` bytes (the whole file when smaller). */
export function readTail(file: string, size: number, bytes: number): Promise<string> {
  const length = Math.min(size, bytes);
  return readSlice(file, size - length, length);
}

/** One JSON Lines record; null for blank lines, cut lines and anything that is not an object. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every object record of a JSON Lines text, in file order. */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const record = parseJsonLine(line);
    if (record) out.push(record);
  }
  return out;
}
