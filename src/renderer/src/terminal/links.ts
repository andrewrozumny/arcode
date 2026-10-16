/** File links in terminal output: `Read(path)` tool calls and `path:line[-line]` references. */
import type { IBufferRange, IDisposable, ILink, Terminal } from '@xterm/xterm';

/** Tool-call lines printed by Claude Code, e.g. `Read(src/main/index.ts)`. Group 1 is the path. */
export const TOOL_CALL_PATTERN =
  /(?:Read|Write|Edit|Bash|Search|Fetch|Web Search|LSP|Edit Notebook|BashOutput|Tmux|AgentOutputTool|ReadMcpResource|Update|Create)\(([^\s)]+(?:\.[a-zA-Z0-9]+)?)\)/g;

/**
 * Bare file references, optionally followed by `:line`, `:line-line` and a trailing `:column`.
 * Groups: 1 path, 2 start line, 3 end line. The trailing whitespace is a lookahead so that
 * neighbouring references separated by a single space are both found.
 */
export const FILE_PATH_PATTERN =
  /(?:^|\s)((?:\.[^/\s()]+|[^\s().]+\.[a-zA-Z0-9]+|[^\s()]+\/[^\s()]+))(?::(\d+)(?:-(\d+))?(?::\d+)?)?(?=\s|$)/g;

/** Paths that contain spaces are only recognised when followed by a line number. */
export const SPACED_PATH_PATTERN =
  /(?:^|[\s"'`])((?:~\/|\.{1,2}\/|\/)?[\w.@+-][\w.@+ -]*(?:\/[\w.@+ -]+)*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?::\d+)?(?=$|[\s"'`),.;])/g;

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_MATCHES_PER_LINE = 8;
const MAX_SPACED_CANDIDATES = 4;

/** One place in a line where a file reference may be; `candidates` are tried in order. */
export interface LinkMatch {
  candidates: { start: number; path: string }[];
  line?: number;
  endLine?: number;
}

function trimPath(text: string, start: number): { start: number; path: string } {
  let path = text;
  let from = start;
  const lead = /^["'`]+/.exec(path);
  if (lead) {
    path = path.slice(lead[0].length);
    from += lead[0].length;
  }
  path = path.replace(/["'`,;.]+$/, '');
  return { start: from, path };
}

function toLine(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Longest candidate first, then with leading words dropped; only candidates that still contain a space. */
function spacedCandidates(path: string, start: number): { start: number; path: string }[] {
  const result: { start: number; path: string }[] = [];
  let offset = 0;
  while (offset < path.length) {
    const candidate = path.slice(offset);
    if (!candidate.includes(' ')) break;
    result.push({ start: start + offset, path: candidate });
    const next = candidate.indexOf(' ');
    offset += next + 1;
  }
  return result;
}

/** Finds file references in one line of terminal text. Pure: no file system access. */
export function findLinkMatches(line: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  const taken: [number, number][] = [];
  const overlaps = (from: number, to: number): boolean => taken.some(([a, b]) => from < b && to > a);
  const claim = (from: number, to: number): void => {
    taken.push([from, to]);
  };

  for (const m of line.matchAll(TOOL_CALL_PATTERN)) {
    const path = m[1];
    if (!path || URL_SCHEME.test(path)) continue;
    const start = (m.index ?? 0) + m[0].length - 1 - path.length;
    claim((m.index ?? 0), (m.index ?? 0) + m[0].length);
    matches.push({ candidates: [{ start, path }] });
  }

  for (const m of line.matchAll(SPACED_PATH_PATTERN)) {
    const full = m[1];
    if (!full || !full.includes(' ')) continue;
    const start = (m.index ?? 0) + m[0].indexOf(full);
    if (overlaps(start, start + full.length)) continue;
    const candidates = spacedCandidates(full, start).slice(0, MAX_SPACED_CANDIDATES);
    if (candidates.length === 0) continue;
    const link: LinkMatch = { candidates };
    const startLine = toLine(m[2]);
    const endLine = toLine(m[3]);
    if (startLine !== undefined) link.line = startLine;
    if (endLine !== undefined) link.endLine = endLine;
    matches.push(link);
  }

  for (const m of line.matchAll(FILE_PATH_PATTERN)) {
    const raw = m[1];
    if (!raw) continue;
    const rawStart = (m.index ?? 0) + m[0].indexOf(raw);
    const { start, path } = trimPath(raw, rawStart);
    if (!path || URL_SCHEME.test(path)) continue;
    if (overlaps(start, start + path.length)) continue;
    claim(start, start + path.length);
    const link: LinkMatch = { candidates: [{ start, path }] };
    const startLine = toLine(m[2]);
    const endLine = toLine(m[3]);
    if (startLine !== undefined) link.line = startLine;
    if (endLine !== undefined) link.endLine = endLine;
    matches.push(link);
    if (matches.length >= MAX_MATCHES_PER_LINE) break;
  }
  return matches.slice(0, MAX_MATCHES_PER_LINE);
}

/** The part of xterm's IBufferLine that lineCells reads. */
export interface CellLine {
  readonly length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * Text of a buffer line plus the cell column of every UTF-16 offset in it. A wide character
 * (CJK, many emoji such as the check mark Claude Code prints) fills two cells but is one string
 * offset, so string offsets alone would put every later link one column too far left.
 */
export function lineCells(line: CellLine): { text: string; columnOf: (offset: number) => number } {
  let text = '';
  const columns: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    text += chars;
    for (let i = 0; i < chars.length; i++) columns.push(x);
  }
  const trimmed = text.replace(/\s+$/, '');
  return { text: trimmed, columnOf: (offset) => columns[offset] ?? offset };
}

export interface LinkDeps {
  projectRoot: () => string;
  /** Returns the absolute path when the file exists, otherwise null. */
  resolveFile: (path: string, projectRoot: string) => Promise<string | null>;
  onOpen: (absolutePath: string, line?: number, endLine?: number) => void;
}

const POSITIVE_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 3_000;
const CACHE_LIMIT = 500;

/** Registers the file link provider on a terminal. Links are underlined on hover and open on click. */
export function registerFileLinks(term: Terminal, deps: LinkDeps): IDisposable {
  const cache = new Map<string, { value: string | null; at: number }>();

  const resolve = async (path: string): Promise<string | null> => {
    const root = deps.projectRoot();
    const key = `${root}\0${path}`;
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < (hit.value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit.value;
    let value: string | null = null;
    try {
      value = await deps.resolveFile(path, root);
    } catch {
      value = null;
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, { value, at: now });
    return value;
  };

  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const bufferLine = term.buffer.active.getLine(y - 1);
      if (!bufferLine) {
        callback(undefined);
        return;
      }
      const { text, columnOf } = lineCells(bufferLine);
      const matches = findLinkMatches(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(
        matches.map(async (match): Promise<ILink | undefined> => {
          for (const candidate of match.candidates) {
            const absolute = await resolve(candidate.path);
            if (!absolute) continue;
            const range: IBufferRange = {
              start: { x: columnOf(candidate.start) + 1, y },
              end: { x: columnOf(candidate.start + candidate.path.length - 1) + 1, y },
            };
            return {
              range,
              text: candidate.path,
              decorations: { pointerCursor: true, underline: true },
              activate: () => deps.onOpen(absolute, match.line, match.endLine),
            };
          }
          return undefined;
        }),
      ).then((links) => {
        // Earlier matches (tool calls, then spaced paths) win over overlapping later ones.
        const found: ILink[] = [];
        for (const link of links) {
          if (!link) continue;
          const clashes = found.some(
            (other) => link.range.start.x <= other.range.end.x && link.range.end.x >= other.range.start.x,
          );
          if (!clashes) found.push(link);
        }
        callback(found.length > 0 ? found : undefined);
      });
    },
  });
}
