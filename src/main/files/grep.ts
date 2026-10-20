/**
 * Find in files: a content search in the project root. Three engines, best first:
 *
 *   rg        `rg --json` when ripgrep is installed (respects .gitignore, fastest)
 *   git       `git grep -n -I --untracked` inside a git work tree
 *   node      a capped walk over the cached file index (which honors .gitignore)
 *
 * Every engine is spawned with an argv array, never a shell string. Results are capped (lines, files,
 * scanned files), long lines are trimmed around the match, a timeout stops runaway searches and the
 * caller can abort through an AbortSignal (the IPC layer cancels a window's previous query). Paths
 * come back project-relative and pass the one path guard (`paths.ts`).
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { GrepEngine, GrepFileResult, GrepMatch, GrepQuery, GrepResult, SearchRange } from '@shared/files';
import { isGitRepo } from './git';
import { getIndex } from './index';
import { normalizeRel, resolveInside } from './paths';

export interface GrepLimits {
  /** Matching lines kept across all files. */
  maxLines: number;
  /** Files with matches kept. */
  maxFiles: number;
  /** Files read by the Node engine. */
  maxScanFiles: number;
  /** Files larger than this are skipped by the Node engine. */
  maxFileBytes: number;
  /** Characters of a line shown in a result (the rest is trimmed with an ellipsis). */
  maxPreview: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: GrepLimits = {
  maxLines: 2000,
  maxFiles: 1000,
  maxScanFiles: 50_000,
  maxFileBytes: 1024 * 1024,
  maxPreview: 240,
  timeoutMs: 10_000,
};

/** Characters kept before the first match; anything earlier is cut with an ellipsis. */
const PREVIEW_CONTEXT = 12;
/** Ranges recorded per line; a line with more occurrences still counts them all. */
const MAX_RANGES_PER_LINE = 50;
const ELLIPSIS = '…';

export interface GrepOptions {
  signal?: AbortSignal;
  limits?: Partial<GrepLimits>;
  /** Engines to try in order (tests pin one). Defaults to rg, git, node. */
  engines?: readonly GrepEngine[];
}

// ---------------------------------------------------------------------------
// Pure helpers: includes, argv, matcher, trimming, parsing. Exported for tests.

/** Splits the include field on commas outside braces; `!glob` goes to `exclude`. */
export function parseIncludes(include: string): { include: string[]; exclude: string[] } {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of include) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  const result = { include: [] as string[], exclude: [] as string[] };
  for (const raw of parts) {
    const glob = raw.trim();
    if (glob.startsWith('!')) {
      const rest = glob.slice(1).trim();
      if (rest) result.exclude.push(rest);
    } else if (glob) {
      result.include.push(glob);
    }
  }
  return result;
}

/** argv for `rg`. The search runs with cwd at the project root over `.`. */
export function buildRgArgs(q: GrepQuery): string[] {
  const args = ['--json', '--no-config', '--no-require-git', '--hidden', '--glob', '!.git', '--max-filesize', '2M'];
  args.push(q.caseSensitive ? '--case-sensitive' : '--ignore-case');
  if (q.wholeWord) args.push('--word-regexp');
  if (!q.regex) args.push('--fixed-strings');
  const { include, exclude } = parseIncludes(q.include);
  for (const glob of include) args.push('--glob', glob);
  for (const glob of exclude) args.push('--glob', `!${glob}`);
  args.push('--regexp', q.query, '--', '.');
  return args;
}

/** argv for `git grep`; `pcre` false falls back to extended regular expressions. */
export function buildGitGrepArgs(q: GrepQuery, pcre = true): string[] {
  const args = ['grep', '-n', '-I', '--untracked', '-z', '--no-color'];
  if (!q.caseSensitive) args.push('-i');
  if (q.wholeWord) args.push('-w');
  args.push(q.regex ? (pcre ? '-P' : '-E') : '-F');
  args.push('-e', q.query, '--');
  const { include, exclude } = parseIncludes(q.include);
  args.push(...include);
  for (const glob of exclude) args.push(`:(exclude)${glob}`);
  return args;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The JavaScript regular expression that finds match ranges for the git and Node engines (git grep
 * reports lines, not ranges). Throws on an invalid pattern.
 */
export function buildMatcher(q: GrepQuery): RegExp {
  const source = q.regex ? q.query : escapeRegExp(q.query);
  const flags = q.caseSensitive ? 'g' : 'gi';
  const word = (pattern: string, unicode: boolean): string =>
    unicode ? `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])` : `(?<!\\w)(?:${pattern})(?!\\w)`;
  try {
    return new RegExp(q.wholeWord ? word(source, true) : source, flags + 'u');
  } catch {
    // Some patterns are valid only without the u flag (identity escapes such as \-).
    return new RegExp(q.wholeWord ? word(source, false) : source, flags);
  }
}

/** Every match of `re` (a global regex) in `line`, at most `max`. Zero-length matches are skipped. */
export function findRanges(re: RegExp, line: string, max = MAX_RANGES_PER_LINE): { ranges: SearchRange[]; count: number } {
  const ranges: SearchRange[] = [];
  let count = 0;
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      if (re.lastIndex > line.length) break;
      continue;
    }
    count++;
    if (ranges.length < max) ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return { ranges, count };
}

/**
 * The shown form of a matching line: trailing newline and leading indentation dropped, and a line
 * longer than `max` cut to a window that starts a little before the first match, with ellipses where
 * text was removed. Ranges are shifted to the new text and clipped to it.
 */
export function trimPreview(line: string, ranges: readonly SearchRange[], max = DEFAULT_LIMITS.maxPreview): { text: string; ranges: SearchRange[] } {
  const full = line.replace(/\r?\n$/, '').replace(/\r$/, '');
  const firstStart = ranges.length > 0 ? Math.min(...ranges.map((r) => r.start)) : 0;
  const indent = full.length - full.trimStart().length;
  const lead = Math.min(indent, firstStart);
  // Start shortly before the first match so it stays visible in a narrow column.
  let start = firstStart - lead > PREVIEW_CONTEXT ? firstStart - PREVIEW_CONTEXT : lead;
  const end = Math.min(full.length, start + max);
  // A long line whose match is near its end shows a full-width window ending at the line end.
  if (end - start < max && full.length - lead > max) start = Math.max(lead, end - max);
  const prefix = start > lead ? ELLIPSIS : '';
  const suffix = end < full.length ? ELLIPSIS : '';
  const shift = prefix.length - start;
  const shifted: SearchRange[] = [];
  for (const r of ranges) {
    const s = Math.max(r.start, start);
    const e = Math.min(r.end, end);
    if (e <= s) continue;
    shifted.push({ start: s + shift, end: e + shift });
  }
  return { text: prefix + full.slice(start, end) + suffix, ranges: shifted };
}

/** UTF-16 offset of byte offset `byte` in the UTF-8 encoding of `text`. */
export function byteToCharOffset(text: string, byte: number): number {
  if (Buffer.byteLength(text, 'utf8') === text.length) return Math.min(byte, text.length);
  return Buffer.from(text, 'utf8').subarray(0, byte).toString('utf8').length;
}

/** One matching line from an engine: project-relative path, 1-based line, full text and its match ranges. */
export interface GrepHit {
  path: string;
  line: number;
  text: string;
  ranges: SearchRange[];
  /** Occurrences in the line; defaults to the number of ranges. */
  count?: number;
}

function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

function rgText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { text?: unknown; bytes?: unknown };
  if (typeof v.text === 'string') return v.text;
  if (typeof v.bytes === 'string') return Buffer.from(v.bytes, 'base64').toString('utf8');
  return null;
}

/** Parses one line of `rg --json` output; null for anything but a well-formed `match` record. */
export function parseRgLine(json: string): GrepHit | null {
  let record: unknown;
  try {
    record = JSON.parse(json);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const { type, data } = record as { type?: unknown; data?: unknown };
  if (type !== 'match' || !data || typeof data !== 'object') return null;
  const d = data as { path?: unknown; lines?: unknown; line_number?: unknown; submatches?: unknown };
  const path = rgText(d.path);
  const text = rgText(d.lines);
  if (path === null || text === null || typeof d.line_number !== 'number') return null;
  const ranges: SearchRange[] = [];
  let count = 0;
  if (Array.isArray(d.submatches)) {
    for (const sub of d.submatches as unknown[]) {
      if (!sub || typeof sub !== 'object') continue;
      const { start, end } = sub as { start?: unknown; end?: unknown };
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) continue;
      count++;
      if (ranges.length < MAX_RANGES_PER_LINE) {
        ranges.push({ start: byteToCharOffset(text, start), end: byteToCharOffset(text, end) });
      }
    }
  }
  return { path: stripDotSlash(path), line: d.line_number, text: text.replace(/\r?\n$/, ''), ranges, count };
}

/** Parses one `git grep -n -z` record (`path\0line\0text`); ranges are added by the caller. */
export function parseGitGrepLine(record: string): { path: string; line: number; text: string } | null {
  const a = record.indexOf('\0');
  if (a <= 0) return null;
  const b = record.indexOf('\0', a + 1);
  if (b < 0) return null;
  const line = Number(record.slice(a + 1, b));
  if (!Number.isInteger(line) || line < 1) return null;
  return { path: stripDotSlash(record.slice(0, a)), line, text: record.slice(b + 1).replace(/\r$/, '') };
}

/**
 * Glob to RegExp with ripgrep-like rules: `*` and `?` stay inside one path segment, `**` crosses
 * segments, `{a,b}` and `[...]` work, and a glob without `/` matches the file name at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '');
  const anchored = g.includes('/');
  if (g.startsWith('/')) g = g.slice(1);
  let out = '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      braces++;
      out += '(?:';
    } else if (ch === '}' && braces > 0) {
      braces--;
      out += ')';
    } else if (ch === ',' && braces > 0) {
      out += '|';
    } else if (ch === '[') {
      const close = g.indexOf(']', i + 1);
      if (close < 0) {
        out += '\\[';
      } else {
        let cls = g.slice(i + 1, close).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += `[${cls}]`;
        i = close;
      }
    } else {
      out += escapeRegExp(ch);
    }
  }
  out += ')'.repeat(braces);
  // A trailing slash or a plain folder glob also matches what is inside it.
  return new RegExp(anchored ? `^${out.replace(/\/$/, '')}(?:/.*)?$` : `(?:^|/)${out}$`);
}

/** Path filter for the Node engine built from the include field. */
export function includeFilter(include: string): (path: string) => boolean {
  const parsed = parseIncludes(include);
  const inc = parsed.include.map(globToRegExp);
  const exc = parsed.exclude.map(globToRegExp);
  return (path) => (inc.length === 0 || inc.some((re) => re.test(path))) && !exc.some((re) => re.test(path));
}

/** Gathers hits into per-file results and enforces the line and file caps. */
export class GrepCollector {
  private readonly files = new Map<string, GrepFileResult>();
  private lines = 0;
  private count = 0;
  truncated = false;

  constructor(private readonly limits: Pick<GrepLimits, 'maxLines' | 'maxFiles' | 'maxPreview'>) {}

  /** Adds a hit; returns false once a cap is reached (the caller stops the engine). */
  add(hit: GrepHit): boolean {
    if (this.lines >= this.limits.maxLines) {
      this.truncated = true;
      return false;
    }
    let file = this.files.get(hit.path);
    if (!file) {
      if (this.files.size >= this.limits.maxFiles) {
        this.truncated = true;
        return false;
      }
      file = { path: hit.path, matches: [], count: 0 };
      this.files.set(hit.path, file);
    }
    const preview = trimPreview(hit.text, hit.ranges, this.limits.maxPreview);
    const first = hit.ranges.length > 0 ? Math.min(...hit.ranges.map((r) => r.start)) : 0;
    const match: GrepMatch = { line: hit.line, column: first + 1, text: preview.text, ranges: preview.ranges };
    const occurrences = Math.max(1, hit.count ?? hit.ranges.length);
    file.matches.push(match);
    file.count += occurrences;
    this.count += occurrences;
    this.lines++;
    if (this.lines >= this.limits.maxLines) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  get size(): number {
    return this.lines;
  }

  result(engine: GrepEngine): GrepResult {
    const files = [...this.files.values()];
    for (const f of files) f.matches.sort((a, b) => a.line - b.line);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      files,
      totalLines: this.lines,
      totalCount: this.count,
      truncated: this.truncated,
      timedOut: false,
      cancelled: false,
      engine,
    };
  }
}

export function emptyResult(engine: GrepEngine, extra: Partial<GrepResult> = {}): GrepResult {
  return { files: [], totalLines: 0, totalCount: 0, truncated: false, timedOut: false, cancelled: false, engine, ...extra };
}

// ---------------------------------------------------------------------------
// Process plumbing.

interface RunOutcome {
  code: number;
  /** The record callback asked to stop and the process was killed. */
  stopped: boolean;
  /** Records seen. */
  records: number;
}

/**
 * Spawns `command` with an argv array and feeds each newline-terminated record of stdout to
 * `onRecord` as UTF-8. Returning false from `onRecord`, or aborting `signal`, kills the process.
 * Rejects only when the process cannot start.
 */
export function runRecords(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  onRecord: (record: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunOutcome> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      resolvePromise({ code: 1, stopped: true, records: 0 });
      return;
    }
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let pending: Buffer = Buffer.alloc(0);
    let stopped = false;
    let records = 0;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let from = 0;
      for (let nl = pending.indexOf(10, from); nl >= 0; nl = pending.indexOf(10, from)) {
        const record = pending.subarray(from, nl).toString('utf8');
        from = nl + 1;
        records++;
        if (!onRecord(record)) {
          stop();
          return;
        }
      }
      pending = pending.subarray(from);
    });
    child.on('error', (error) => {
      signal.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (!stopped && pending.length > 0) {
        records++;
        onRecord(pending.toString('utf8'));
      }
      resolvePromise({ code: code ?? 1, stopped, records });
    });
  });
}

let rgCache: { at: number; path: string | null } | null = null;

/** Absolute path of `rg` on PATH (plus the Homebrew folders a Finder launch lacks); null when absent. */
export async function findRipgrep(): Promise<string | null> {
  if (rgCache && Date.now() - rgCache.at < 60_000) return rgCache.path;
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  let found: string | null = null;
  for (const dir of new Set(dirs)) {
    const candidate = join(dir, 'rg');
    try {
      await access(candidate, constants.X_OK);
      found = candidate;
      break;
    } catch {
      // keep looking
    }
  }
  rgCache = { at: Date.now(), path: found };
  return found;
}

// ---------------------------------------------------------------------------
// Engines.

class EngineUnavailable extends Error {}

async function runRg(root: string, q: GrepQuery, signal: AbortSignal, collector: GrepCollector): Promise<string | undefined> {
  const rg = await findRipgrep();
  if (!rg) throw new EngineUnavailable('rg');
  let outcome: RunOutcome;
  try {
    outcome = await runRecords(rg, buildRgArgs(q), root, signal, (record) => {
      const hit = parseRgLine(record);
      return hit ? collector.add(hit) : true;
    });
  } catch {
    throw new EngineUnavailable('rg');
  }
  // rg exits 2 on errors; with nothing found that means the pattern itself was rejected.
  if (!outcome.stopped && outcome.code === 2 && collector.size === 0) return 'Invalid search pattern';
  return undefined;
}

async function runGitGrep(root: string, q: GrepQuery, signal: AbortSignal, collector: GrepCollector): Promise<string | undefined> {
  if (!(await isGitRepo(root))) throw new EngineUnavailable('git');
  let matcher: RegExp | null = null;
  try {
    matcher = buildMatcher(q);
  } catch {
    // git may still accept a pattern JavaScript rejects (PCRE syntax); lines then show without highlight.
  }
  const run = (pcre: boolean): Promise<RunOutcome> =>
    runRecords('git', buildGitGrepArgs(q, pcre), root, signal, (record) => {
      const parsed = parseGitGrepLine(record);
      if (!parsed) return true;
      const found = matcher ? findRanges(matcher, parsed.text) : { ranges: [], count: 1 };
      return collector.add({ ...parsed, ranges: found.ranges, count: found.count });
    }, { ...process.env, GIT_OPTIONAL_LOCKS: '0' });
  let outcome: RunOutcome;
  try {
    outcome = await run(true);
    // 128: git refused the pattern, or this git has no PCRE support; retry once with -E.
    if (q.regex && outcome.code === 128 && outcome.records === 0 && !signal.aborted) outcome = await run(false);
  } catch {
    throw new EngineUnavailable('git');
  }
  if (!outcome.stopped && outcome.code === 128 && collector.size === 0) return 'Invalid search pattern';
  return undefined;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

async function runNode(
  root: string,
  q: GrepQuery,
  signal: AbortSignal,
  collector: GrepCollector,
  limits: GrepLimits,
): Promise<string | undefined> {
  let matcher: RegExp;
  try {
    matcher = buildMatcher(q);
  } catch {
    return 'Invalid regular expression';
  }
  const accept = includeFilter(q.include);
  const files = (await getIndex(root)).filter(accept);
  let scanned = 0;
  for (const rel of files) {
    if (signal.aborted) break;
    if (scanned >= limits.maxScanFiles) {
      collector.truncated = true;
      break;
    }
    scanned++;
    const abs = join(root, rel);
    let buffer: Buffer;
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > limits.maxFileBytes) continue;
      buffer = await readFile(abs);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] as string;
      const found = findRanges(matcher, text);
      if (found.count === 0) continue;
      if (!collector.add({ path: rel, line: i + 1, text, ranges: found.ranges, count: found.count })) return undefined;
    }
  }
  return undefined;
}

/** Drops results whose path is not a normalized project path that resolves inside `root`. */
async function guardPaths(root: string, result: GrepResult): Promise<GrepResult> {
  const kept: GrepFileResult[] = [];
  for (const file of result.files) {
    try {
      const path = normalizeRel(file.path);
      if (!path) continue;
      await resolveInside(root, path);
      kept.push({ ...file, path });
    } catch {
      // outside the project or malformed: never shown
    }
  }
  if (kept.length === result.files.length) return result;
  const totalLines = kept.reduce((n, f) => n + f.matches.length, 0);
  const totalCount = kept.reduce((n, f) => n + f.count, 0);
  return { ...result, files: kept, totalLines, totalCount };
}

/** Runs one Find in files query in `root`. Never rejects; failures come back as `error`. */
export async function grepProject(root: string, q: GrepQuery, options: GrepOptions = {}): Promise<GrepResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const engines = options.engines ?? (['rg', 'git', 'node'] as const);
  if (q.query.length === 0) return emptyResult(engines[0] ?? 'node');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);
  const outer = options.signal;
  const onOuterAbort = (): void => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    for (const engine of engines) {
      const collector = new GrepCollector(limits);
      let error: string | undefined;
      try {
        if (engine === 'rg') error = await runRg(root, q, controller.signal, collector);
        else if (engine === 'git') error = await runGitGrep(root, q, controller.signal, collector);
        else error = await runNode(root, q, controller.signal, collector, limits);
      } catch (e) {
        if (e instanceof EngineUnavailable) continue;
        return emptyResult(engine, { error: e instanceof Error ? e.message : String(e) });
      }
      if (outer?.aborted) return emptyResult(engine, { cancelled: true });
      const result = await guardPaths(root, collector.result(engine));
      return { ...result, timedOut, ...(error ? { error } : {}) };
    }
    return emptyResult('node', { error: 'No search engine available' });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}
