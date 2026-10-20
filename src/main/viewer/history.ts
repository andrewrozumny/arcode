/**
 * Local history: copies of text files kept by ARcode itself, independent of git, so a version from
 * before Claude Code (or anything else) rewrote a file can be compared and restored.
 *
 * Layout: `<userData>/history/<project key>/<encoded relative path>/<timestamp>-<source>.txt`, where
 * the project key is a hash of the resolved project root and the encoded path is the
 * project-relative path with every `/` percent-encoded, so each file gets one flat folder.
 *
 * When a snapshot is taken:
 * - `save`: before ARcode writes a file, the content that is on disk right then. Autosave writes
 *   every second while typing, so these are throttled: a new one is kept only when the file has no
 *   snapshot yet, the newest snapshot came from an outside change, the newest is at least
 *   `SAVE_SNAPSHOT_INTERVAL_MS` old, or the content differs from it by a large change (see
 *   `isLargeChange`). A restore always keeps one.
 * - `external`: a file open in a viewer changed on disk from outside ARcode. The content ARcode last
 *   knew (from opening, saving or the previous change) is kept, never throttled. A deleted file
 *   keeps its last known content the same way.
 * Identical consecutive snapshots are never stored twice. Only text files up to
 * `HISTORY_MAX_BYTES` are kept, at most `HISTORY_MAX_PER_FILE` per file, and snapshots older than
 * `HISTORY_MAX_AGE_MS` are removed at startup.
 *
 * Callers pass absolute paths they already resolved through `files/paths.ts`; this module refuses
 * any path outside the given root again before touching the history folder. No Electron imports,
 * so it can be unit tested.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { SnapshotInfo, SnapshotSource } from '@shared/viewer';
import { isInside, normalizeRel } from '../files/paths';
import { looksBinary } from './service';

export const HISTORY_MAX_BYTES = 1024 * 1024;
export const HISTORY_MAX_PER_FILE = 50;
export const HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Minimum age of the newest snapshot before another "before save" one is kept. */
export const SAVE_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
/** A change of at least this many characters always counts as large. */
export const LARGE_CHANGE_CHARS = 2000;
/** Smaller files: a change counts as large from this share of the file, if it is at least `LARGE_CHANGE_MIN_CHARS`. */
export const LARGE_CHANGE_RATIO = 0.3;
export const LARGE_CHANGE_MIN_CHARS = 200;
/** How many files' last known content is kept in memory. */
const KNOWN_LIMIT = 200;
/** Encoded paths longer than this are shortened and made unique with a hash (file names max out at 255 bytes). */
const MAX_ENCODED_LENGTH = 180;

const SNAPSHOT_NAME = /^(\d{1,16})-(save|external)\.txt$/;

export function historyDir(userData: string): string {
  return join(userData, 'history');
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Folder name of a project: a short hash of its resolved root. */
export function projectKey(root: string): string {
  return sha256(resolve(root)).slice(0, 16);
}

/** One flat folder name per project-relative path; reversible unless it had to be shortened. */
export function encodeRelPath(rel: string): string {
  const normalized = normalizeRel(rel);
  if (normalized === '') throw new Error('Cannot keep history of the project root');
  const encoded = encodeURIComponent(normalized);
  if (encoded.length <= MAX_ENCODED_LENGTH) return encoded;
  return `${encoded.slice(0, 120).replace(/%[0-9A-F]?$/, '')}~${sha256(normalized).slice(0, 16)}`;
}

/** Project-relative path of `abs`; throws when it is not inside `root`. */
export function relInside(root: string, abs: string): string {
  const absRoot = resolve(root);
  const target = resolve(abs);
  if (target === absRoot || !isInside(absRoot, target)) throw new Error(`Path is outside the project: ${abs}`);
  return relative(absRoot, target).split(sep).join('/');
}

export function snapshotName(timestamp: number, source: SnapshotSource): string {
  return `${timestamp}-${source}.txt`;
}

export function parseSnapshotName(name: string): { timestamp: number; source: SnapshotSource } | null {
  const match = SNAPSHOT_NAME.exec(name);
  if (!match) return null;
  return { timestamp: Number(match[1]), source: match[2] as SnapshotSource };
}

/** Length of the changed middle part between two texts (after their common prefix and suffix). */
export function changedSpan(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  let start = 0;
  while (start < shorter && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < shorter - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return Math.max(a.length, b.length) - start - end;
}

export function isLargeChange(a: string, b: string): boolean {
  const span = changedSpan(a, b);
  if (span >= LARGE_CHANGE_CHARS) return true;
  return span >= LARGE_CHANGE_MIN_CHARS && span >= LARGE_CHANGE_RATIO * Math.max(a.length, b.length);
}

export interface NewestSnapshot {
  timestamp: number;
  source: SnapshotSource;
  content: string;
}

export interface SnapshotDecision {
  newest: NewestSnapshot | null;
  content: string;
  source: SnapshotSource;
  now: number;
  /** Keep a "before save" snapshot regardless of the throttle (restore). */
  force?: boolean;
}

/** Whether `content` should become a new snapshot. Pure; see the module comment for the rules. */
export function shouldSnapshot({ newest, content, source, now, force = false }: SnapshotDecision): boolean {
  if (!newest) return true;
  if (newest.content === content) return false;
  if (source === 'external' || force) return true;
  if (newest.source === 'external') return true;
  if (now - newest.timestamp >= SAVE_SNAPSHOT_INTERVAL_MS) return true;
  return isLargeChange(newest.content, content);
}

/** Text content of `abs`, or null when it is missing, not a regular file, binary or over the cap. */
async function readText(abs: string): Promise<string | null> {
  try {
    const info = await stat(abs);
    if (!info.isFile() || info.size > HISTORY_MAX_BYTES) return null;
    const bytes = await readFile(abs);
    if (bytes.length > HISTORY_MAX_BYTES || looksBinary(bytes)) return null;
    return bytes.toString('utf-8');
  } catch {
    return null;
  }
}

/** Hooks `writeFile` calls around a guarded write. */
export interface WriteHooks {
  /** After the mtime check, before writing `next`. */
  beforeWrite(abs: string, next: string): Promise<void>;
  /** After the write finished; `ok` is false when nothing was written. */
  afterWrite(abs: string, ok: boolean): void;
}

export class LocalHistory {
  /** Last content ARcode knows to be on disk, per absolute path (open or saved files). */
  private readonly known = new Map<string, string | null>();
  private readonly newest = new Map<string, NewestSnapshot | null>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** ARcode writes in progress per absolute path; a disk change seen meanwhile is our own. */
  private readonly writing = new Map<string, number>();

  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Folder holding the snapshots of `abs`; throws when `abs` is outside `root`. */
  fileDir(root: string, abs: string): string {
    return join(this.baseDir, projectKey(root), encodeRelPath(relInside(root, abs)));
  }

  /** Runs `task` after the previous task for the same file, so snapshots of one file never race. */
  private serial<T>(dir: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(dir) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    this.queues.set(dir, settled);
    void settled.then(() => {
      if (this.queues.get(dir) === settled) this.queues.delete(dir);
    });
    return run;
  }

  private remember(abs: string, content: string | null): void {
    this.known.delete(abs);
    this.known.set(abs, content);
    if (this.known.size > KNOWN_LIMIT) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
  }

  private async entries(dir: string): Promise<{ name: string; timestamp: number; source: SnapshotSource }[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: { name: string; timestamp: number; source: SnapshotSource }[] = [];
    for (const name of names) {
      const parsed = parseSnapshotName(name);
      if (parsed) out.push({ name, ...parsed });
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }

  private async loadNewest(dir: string): Promise<NewestSnapshot | null> {
    if (this.newest.has(dir)) return this.newest.get(dir) ?? null;
    const [first] = await this.entries(dir);
    let value: NewestSnapshot | null = null;
    if (first) {
      const content = await readText(join(dir, first.name));
      if (content !== null) value = { timestamp: first.timestamp, source: first.source, content };
    }
    this.newest.set(dir, value);
    return value;
  }

  /** Stores `content` as a snapshot of `abs` when the rules allow it. Returns whether one was written. */
  async snapshot(root: string, abs: string, content: string, source: SnapshotSource, force = false): Promise<boolean> {
    if (Buffer.byteLength(content, 'utf-8') > HISTORY_MAX_BYTES) return false;
    const dir = this.fileDir(root, abs);
    return this.serial(dir, () => this.store(dir, content, source, force));
  }

  /** Writes a snapshot when `shouldSnapshot` allows it and enforces the per-file cap. Call inside `serial`. */
  private async store(dir: string, content: string, source: SnapshotSource, force = false): Promise<boolean> {
    const newest = await this.loadNewest(dir);
    const now = this.now();
    if (!shouldSnapshot({ newest, content, source, now, force })) return false;
    const timestamp = newest && newest.timestamp >= now ? newest.timestamp + 1 : now;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, snapshotName(timestamp, source)), content, 'utf-8');
    this.newest.set(dir, { timestamp, source, content });
    const all = await this.entries(dir);
    for (const extra of all.slice(HISTORY_MAX_PER_FILE)) await rm(join(dir, extra.name), { force: true });
    return true;
  }

  /** Hooks for `writeFile`: keep what is on disk before it is replaced. `force` skips the throttle. */
  writeHooks(root: string, force = false): WriteHooks {
    return {
      beforeWrite: async (abs, next) => {
        this.writing.set(abs, (this.writing.get(abs) ?? 0) + 1);
        try {
          const previous = await readText(abs);
          if (previous !== null) await this.snapshot(root, abs, previous, 'save', force);
        } catch {
          // History is best effort: a failed snapshot never blocks the save.
        }
        this.remember(abs, next);
      },
      afterWrite: (abs, ok) => {
        const left = (this.writing.get(abs) ?? 1) - 1;
        if (left > 0) this.writing.set(abs, left);
        else this.writing.delete(abs);
        if (!ok) this.known.delete(abs);
      },
    };
  }

  /** Records the current disk content of a file that was just opened, unless it is already known. */
  async prime(abs: string): Promise<void> {
    if (this.known.has(abs)) return;
    const content = await readText(abs);
    if (!this.known.has(abs)) this.remember(abs, content);
  }

  /**
   * A watched file changed on disk (or vanished). When its content is no longer what ARcode last
   * knew, the known content becomes an "external change" snapshot. Our own saves land here too,
   * but then the disk already matches the known content and nothing is stored.
   */
  async externalChange(root: string, abs: string): Promise<boolean> {
    let dir: string;
    try {
      dir = this.fileDir(root, abs);
    } catch {
      return false;
    }
    // Serialised with snapshots of the same file so two windows watching it see one change once.
    return this.serial(dir, async () => {
      if (this.writing.has(abs)) return false;
      const current = await readText(abs);
      if (this.writing.has(abs)) return false;
      const previous = this.known.get(abs);
      this.remember(abs, current);
      if (previous === undefined || previous === null || previous === current) return false;
      return this.store(dir, previous, 'external');
    }).catch(() => false);
  }

  /** Snapshots of `abs`, newest first. */
  async list(root: string, abs: string): Promise<SnapshotInfo[]> {
    const dir = this.fileDir(root, abs);
    const out: SnapshotInfo[] = [];
    for (const entry of await this.entries(dir)) {
      try {
        const info = await stat(join(dir, entry.name));
        out.push({ id: entry.name, timestamp: entry.timestamp, source: entry.source, size: info.size });
      } catch {
        // Pruned meanwhile.
      }
    }
    return out;
  }

  /** Content of one snapshot, or null when it is gone. Throws on a malformed id. */
  async read(root: string, abs: string, id: string): Promise<string | null> {
    if (!parseSnapshotName(id)) throw new Error('Invalid snapshot');
    return readText(join(this.fileDir(root, abs), id));
  }

  /**
   * Startup cleanup: removes snapshots older than `maxAgeMs`, enforces the per-file cap and drops
   * folders left empty. Best effort; returns how many snapshots went.
   */
  async prune(maxAgeMs = HISTORY_MAX_AGE_MS): Promise<number> {
    const now = this.now();
    let removed = 0;
    const list = async (dir: string): Promise<string[]> => readdir(dir).catch(() => [] as string[]);
    for (const project of await list(this.baseDir)) {
      const projectDir = join(this.baseDir, project);
      for (const file of await list(projectDir)) {
        const dir = join(projectDir, file);
        const entries = await this.entries(dir);
        for (const [index, entry] of entries.entries()) {
          if (index < HISTORY_MAX_PER_FILE && now - entry.timestamp <= maxAgeMs) continue;
          try {
            await rm(join(dir, entry.name), { force: true });
            removed++;
          } catch {
            // Try again next start.
          }
        }
        this.newest.delete(dir);
        await rmdir(dir).catch(() => undefined);
      }
      await rmdir(projectDir).catch(() => undefined);
    }
    return removed;
  }
}
