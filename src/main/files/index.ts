import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HEAVY_DIRS } from '@shared/files';
import type { SearchResult } from '@shared/files';
import { positionsToRanges, scorePath } from './fuzzy';
import { isGitRepo, runGit } from './git';
import { createIgnoreMatcher } from './ignoreFallback';

const MAX_WALK_FILES = 300_000;

/** Lists project files via git; falls back to a walk that honors .gitignore and skips heavy folders. */
export async function listProjectFiles(root: string): Promise<string[]> {
  if (await isGitRepo(root)) {
    try {
      const result = await runGit(root, ['ls-files', '-co', '--exclude-standard', '-z']);
      if (result.code === 0) {
        return result.stdout.toString('utf8').split('\0').filter(Boolean);
      }
    } catch {
      // fall through to the walk
    }
  }
  return walkFiles(root);
}

async function walkFiles(root: string): Promise<string[]> {
  const matcher = createIgnoreMatcher(root);
  const files: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0 && files.length < MAX_WALK_FILES) {
    const dir = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (HEAVY_DIRS.has(entry.name)) continue;
        if (await matcher.isIgnored(rel, true)) continue;
        queue.push(rel);
      } else if (!(await matcher.isIgnored(rel, false))) {
        files.push(rel);
      }
    }
  }
  return files;
}

/** Ranks `paths` against `query`, best first. Pure; used by the cached index and by tests. */
export function rankPaths(paths: readonly string[], query: string, limit = 50): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit).map((path) => ({ path, score: 0, ranges: [] }));
  const hits: { path: string; score: number; positions: number[] }[] = [];
  for (const path of paths) {
    const scored = scorePath(path, q);
    if (scored) hits.push({ path, score: scored.score - path.length * 0.01, positions: scored.positions });
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return hits.slice(0, limit).map((h) => ({ path: h.path, score: h.score, ranges: positionsToRanges(h.positions) }));
}

interface Entry {
  paths: string[] | null;
  building: Promise<string[]> | null;
  stale: boolean;
  timer: NodeJS.Timeout | null;
}

const entries = new Map<string, Entry>();
const REBUILD_DEBOUNCE_MS = 1000;

function entryFor(root: string): Entry {
  let entry = entries.get(root);
  if (!entry) {
    entry = { paths: null, building: null, stale: false, timer: null };
    entries.set(root, entry);
  }
  return entry;
}

function build(root: string): Promise<string[]> {
  const entry = entryFor(root);
  if (entry.building) return entry.building;
  entry.stale = false;
  entry.building = listProjectFiles(root)
    .then((paths) => {
      entry.paths = paths;
      return paths;
    })
    .finally(() => {
      entry.building = null;
      if (entry.stale) scheduleRebuild(root);
    });
  return entry.building;
}

function scheduleRebuild(root: string): void {
  const entry = entryFor(root);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void build(root);
  }, REBUILD_DEBOUNCE_MS);
}

/** Marks the project's file list as outdated; rebuilds in the background after a 1 s quiet period. */
export function invalidateIndex(root: string): void {
  const entry = entries.get(root);
  if (!entry) return;
  entry.stale = true;
  if (!entry.building) scheduleRebuild(root);
}

/** Builds (or returns) the cached list of project files. */
export async function getIndex(root: string): Promise<string[]> {
  const entry = entryFor(root);
  return entry.paths ?? build(root);
}

export async function search(root: string, query: string, limit = 50): Promise<SearchResult[]> {
  return rankPaths(await getIndex(root), query, limit);
}

export function dropIndex(root: string): void {
  const entry = entries.get(root);
  if (entry?.timer) clearTimeout(entry.timer);
  entries.delete(root);
}
