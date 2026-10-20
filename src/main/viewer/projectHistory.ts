/**
 * Local history for files that are not open in a viewer: the project watcher reports changed paths
 * here, and each changed text file goes through `LocalHistory.projectChange`, which snapshots the
 * previous content as "changed outside". The previous content of a file comes from the history's
 * bounded content cache or, the first time the file is seen changing, from its HEAD version, so the
 * first edit Claude Code (or anything else) makes to a committed file can still be undone.
 *
 * Kept cheap on big repositories:
 * - only what the watcher lets through (no heavy folders, no git internals), minus gitignored paths
 *   (one `git check-ignore` per batch, or the .gitignore fallback outside git);
 * - a batch with more than `BULK_CHANGE_LIMIT` files (a checkout, a rebase, a formatter run) is
 *   skipped: nothing is snapshotted, the cached content of those files is dropped (it is stale now)
 *   and one line is logged;
 * - HEAD versions of all uncached files of a batch come from one `git cat-file --batch`;
 * - files are read `CONCURRENCY` at a time, and batches of one project run one after another.
 *
 * Paths go through `files/paths.ts`; git runs through `runGit` (GIT_OPTIONAL_LOCKS=0). No Electron
 * imports, so it can be unit tested.
 */
import { lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { mapLimit } from '../concurrency';
import { isGitRepo, runGit } from '../files/git';
import { createIgnoreMatcher } from '../files/ignoreFallback';
import { normalizeRel, resolveInside } from '../files/paths';
import { gitCheckIgnore } from '../files/service';
import { classifyWatchPath } from '../files/watcher';
import { HISTORY_MAX_BYTES } from './history';
import type { LocalHistory } from './history';
import { looksBinary } from './service';

/** A batch with more changed (not ignored) files than this is a bulk change and is skipped. */
export const BULK_CHANGE_LIMIT = 100;
/** Above this many raw paths a batch is skipped without even asking git what is ignored. */
const IGNORE_CHECK_LIMIT = 5000;
/** Files read or snapshotted at the same time. */
const CONCURRENCY = 4;
/**
 * Cached content remembered this shortly before a bulk batch arrived survives the skip: it was
 * refreshed by an open file's watcher during the change (watcher debounce plus its longest wait).
 */
const BULK_FRESH_MS = 2500;
/** At most one "skipped a bulk change" line per project in this interval. */
const BULK_LOG_INTERVAL_MS = 60 * 1000;

const OBJECT_HEADER = /^[0-9a-f]{40,64} (\w+) (\d+)$/;

/**
 * HEAD versions of `rels` (project-relative, no newlines) with one `git cat-file --batch`. A path
 * that is not a text blob in HEAD, is binary or over `maxBytes` maps to null. Empty outside git.
 */
export async function headTexts(root: string, rels: string[], maxBytes = HISTORY_MAX_BYTES): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (rels.length === 0) return out;
  let stdout: Buffer;
  try {
    const result = await runGit(resolve(root), ['cat-file', '--batch'], rels.map((rel) => `HEAD:./${rel}\n`).join(''));
    if (result.code !== 0) return out;
    stdout = result.stdout;
  } catch {
    return out;
  }
  let pos = 0;
  for (const rel of rels) {
    const newline = stdout.indexOf(0x0a, pos);
    if (newline < 0) break;
    const header = OBJECT_HEADER.exec(stdout.toString('utf-8', pos, newline));
    pos = newline + 1;
    if (!header) {
      out.set(rel, null);
      continue;
    }
    const size = Number(header[2]);
    const body = stdout.subarray(pos, pos + size);
    pos += size + 1;
    out.set(rel, header[1] === 'blob' && size <= maxBytes && !looksBinary(body) ? body.toString('utf-8') : null);
  }
  return out;
}

export interface ProjectHistoryOptions {
  /** Bulk threshold; defaults to `BULK_CHANGE_LIMIT`. */
  bulkLimit?: number;
  log?: (message: string) => void;
  now?: () => number;
}

export class ProjectHistory {
  private readonly queues = new Map<string, Promise<number>>();
  private readonly lastBulkLog = new Map<string, number>();
  private readonly bulkLimit: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(
    private readonly history: LocalHistory,
    options: ProjectHistoryOptions = {},
  ) {
    this.bulkLimit = options.bulkLimit ?? BULK_CHANGE_LIMIT;
    this.log = options.log ?? ((message) => console.log(`[arcode] ${message}`));
    this.now = options.now ?? Date.now;
  }

  /**
   * The project watcher saw `paths` (project-relative) change under `root`. Resolves to the number
   * of snapshots taken. Batches of one root are handled in order; failures are swallowed.
   */
  changed(root: string, paths: readonly string[]): Promise<number> {
    const key = resolve(root);
    const arrived = this.now();
    const run = (this.queues.get(key) ?? Promise.resolve(0))
      .then(() => this.process(root, paths, arrived))
      .catch(() => 0);
    this.queues.set(key, run);
    void run.then(() => {
      if (this.queues.get(key) === run) this.queues.delete(key);
    });
    return run;
  }

  private async process(root: string, paths: readonly string[], arrived: number): Promise<number> {
    const rels = new Set<string>();
    for (const path of paths) {
      let rel: string;
      try {
        rel = normalizeRel(path);
      } catch {
        continue;
      }
      // cat-file reads one path per line; such names are not worth the trouble.
      if (rel === '' || rel.includes('\n') || classifyWatchPath(rel) !== 'project') continue;
      rels.add(rel);
    }
    if (rels.size === 0) return 0;
    if (rels.size > IGNORE_CHECK_LIMIT) return this.skipBulk(root, [...rels], arrived);

    const repo = await isGitRepo(root);
    const candidates = await this.notIgnored(root, [...rels], repo);
    if (candidates.length > this.bulkLimit) return this.skipBulk(root, candidates, arrived);
    if (candidates.length === 0) return 0;

    const files = (
      await mapLimit(candidates, CONCURRENCY, async (rel) => {
        try {
          return { rel, abs: await resolveInside(root, rel) };
        } catch {
          return null;
        }
      })
    ).filter((file): file is { rel: string; abs: string } => file !== null);

    // HEAD seeds only for files never seen before that could be kept (missing now counts: deleted).
    let seeds = new Map<string, string | null>();
    if (repo) {
      const unseen = await mapLimit(files, CONCURRENCY, async ({ rel, abs }) => {
        if (this.history.isKnown(abs)) return null;
        try {
          const info = await lstat(abs);
          return info.isFile() && info.size <= HISTORY_MAX_BYTES ? rel : null;
        } catch {
          return rel;
        }
      });
      seeds = await headTexts(root, unseen.filter((rel): rel is string => rel !== null));
    }

    const stored = await mapLimit(files, CONCURRENCY, ({ rel, abs }) =>
      this.history.projectChange(root, abs, seeds.get(rel) ?? null),
    );
    return stored.filter(Boolean).length;
  }

  private async notIgnored(root: string, rels: string[], repo: boolean): Promise<string[]> {
    if (repo) {
      const ignored = await gitCheckIgnore(resolve(root), rels);
      return ignored ? rels.filter((rel) => !ignored.has(rel)) : rels;
    }
    const matcher = createIgnoreMatcher(resolve(root));
    const flags = await mapLimit(rels, CONCURRENCY, (rel) => matcher.isIgnored(rel, false));
    return rels.filter((_rel, index) => !flags[index]);
  }

  /** A bulk change: no snapshots, and what was cached for those files is stale now. */
  private skipBulk(root: string, rels: string[], arrived: number): number {
    const absRoot = resolve(root);
    for (const rel of rels) this.history.forget(resolve(absRoot, rel), arrived - BULK_FRESH_MS);
    const now = this.now();
    const last = this.lastBulkLog.get(absRoot);
    if (last === undefined || now - last >= BULK_LOG_INTERVAL_MS) {
      this.lastBulkLog.set(absRoot, now);
      this.log(`local history: skipped a bulk change of ${rels.length} files in ${basename(absRoot)}`);
    }
    return 0;
  }
}
