/**
 * The Changes view: every file that differs from HEAD, with +/- line counts. Read-only: status
 * comes from `git status`, counts from `git diff --numstat HEAD`, untracked files are counted by
 * reading them. All git runs go through runGit (GIT_OPTIONAL_LOCKS=0, ADR 0007).
 */
import { readFile, stat } from 'node:fs/promises';
import type { ChangedFile, ChangesResult } from '@shared/files';
import { mapLimit } from '../concurrency';
import { isGitRepo, runGit } from './git';
import { parsePorcelainEntries } from './gitStatus';
import type { PorcelainEntry } from './gitStatus';
import { resolveInside } from './paths';

export interface NumstatEntry {
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

/** Untracked files larger than this are listed without a line count. */
const MAX_COUNT_BYTES = 2 * 1024 * 1024;
/** At most this many untracked files are read for line counts. */
const MAX_COUNTED_FILES = 2000;
/** Bytes looked at for a NUL when deciding that an untracked file is binary (git's own heuristic). */
const BINARY_SNIFF = 8000;

function count(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Parses `git diff --numstat -z` output into path -> counts. A record is `added\tdeleted\tpath\0`, or
 * `added\tdeleted\t\0old\0new\0` for a rename (keyed by the new path). Binary files show `-\t-`.
 */
export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const out = new Map<string, NumstatEntry>();
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const first = token.indexOf('\t');
    const second = first < 0 ? -1 : token.indexOf('\t', first + 1);
    if (second < 0) continue;
    const a = token.slice(0, first);
    const d = token.slice(first + 1, second);
    let path = token.slice(second + 1);
    if (path === '') {
      // Rename or copy: the old and the new path follow as separate tokens.
      path = tokens[i + 2] ?? '';
      i += 2;
    }
    if (!path) continue;
    const binary = a === '-' && d === '-';
    out.set(path, { added: binary ? null : count(a), deleted: binary ? null : count(d), binary });
  }
  return out;
}

/** Line count of a text buffer (a last line without a newline counts); null when it looks binary. */
export function countLines(buffer: Uint8Array): number | null {
  const sniff = Math.min(buffer.length, BINARY_SNIFF);
  for (let i = 0; i < sniff; i++) if (buffer[i] === 0) return null;
  let lines = 0;
  for (const byte of buffer) if (byte === 10) lines++;
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 10) lines++;
  return lines;
}

/** Re-bases a repo-root relative path onto the project root; null when it lies outside it. */
function rebase(path: string, prefix: string): string | null {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Joins status entries with numstat counts into project-relative changed files, sorted by path. */
export function mergeChanges(
  entries: readonly PorcelainEntry[],
  numstat: ReadonlyMap<string, NumstatEntry>,
  prefix: string,
): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const entry of entries) {
    const path = rebase(entry.path, prefix);
    if (path === null || path === '') continue;
    const origPath = entry.origPath === undefined ? null : rebase(entry.origPath, prefix);
    const stats = numstat.get(path);
    files.push({
      path,
      status: entry.code,
      ...(origPath ? { origPath } : {}),
      added: stats?.added ?? null,
      deleted: stats?.deleted ?? null,
      binary: stats?.binary ?? false,
    });
  }
  return files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

async function untrackedLines(root: string, rel: string): Promise<{ lines: number | null; binary: boolean }> {
  try {
    const abs = await resolveInside(root, rel);
    const info = await stat(abs);
    if (!info.isFile() || info.size > MAX_COUNT_BYTES) return { lines: null, binary: false };
    const lines = countLines(await readFile(abs));
    return { lines, binary: lines === null };
  } catch {
    return { lines: null, binary: false };
  }
}

const NOT_GIT: ChangesResult = { git: false, files: [] };

/** Files changed against HEAD in `root` (an absolute project folder already checked by the caller). */
export async function getChanges(root: string): Promise<ChangesResult> {
  if (!(await isGitRepo(root))) return NOT_GIT;
  try {
    const [status, prefixResult, diff] = await Promise.all([
      runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      runGit(root, ['rev-parse', '--show-prefix']),
      // --relative: paths relative to the project root, which may be a subfolder of the repository.
      // Fails without a first commit; the files are still listed, without counts.
      runGit(root, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--relative', 'HEAD', '--']),
    ]);
    if (status.code !== 0) return { git: true, files: [] };
    const prefix = prefixResult.stdout.toString().trim();
    const numstat = diff.code === 0 ? parseNumstat(diff.stdout.toString('utf8')) : new Map<string, NumstatEntry>();
    const files = mergeChanges(parsePorcelainEntries(status.stdout.toString('utf8')), numstat, prefix);
    const untracked = files.filter((f) => f.status === '?').slice(0, MAX_COUNTED_FILES);
    await mapLimit(untracked, 16, async (file) => {
      const { lines, binary } = await untrackedLines(root, file.path);
      file.added = lines;
      file.deleted = lines === null ? null : 0;
      file.binary = binary;
    });
    return { git: true, files };
  } catch {
    return { git: true, files: [] };
  }
}
