/** Recent files in the Go to File palette. Pure, so it can be unit tested. */
import type { SearchRange, SearchResult } from '@shared/files';

/** Which list the palette shows: the whole project (Cmd+P) or only recent files (Cmd+Shift+E). */
export type FileSearchMode = 'files' | 'recent';

/**
 * Case-insensitive subsequence match of `query` in `path`, preferring the file name: the
 * matched ranges, or null when it does not match.
 */
export function matchRanges(path: string, query: string): SearchRange[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const lower = path.toLowerCase();
  const nameStart = lower.lastIndexOf('/') + 1;
  const scan = (from: number): number[] | null => {
    const positions: number[] = [];
    let at = from;
    for (const char of q) {
      const found = lower.indexOf(char, at);
      if (found < 0) return null;
      positions.push(found);
      at = found + 1;
    }
    return positions;
  };
  const positions = scan(nameStart) ?? scan(0);
  if (!positions) return null;
  const ranges: SearchRange[] = [];
  for (const position of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === position) last.end = position + 1;
    else ranges.push({ start: position, end: position + 1 });
  }
  return ranges;
}

/** Recent files matching `query`, most recent first, without the file that is in front now. */
export function recentResults(recent: readonly string[], query: string, current: string | null): SearchResult[] {
  const out: SearchResult[] = [];
  for (const path of recent) {
    if (path === current) continue;
    const ranges = matchRanges(path, query);
    if (ranges) out.push({ path, score: 0, ranges });
  }
  return out;
}

/** Cmd+P with an empty query: recent files first, then the rest of the project, no duplicates. */
export function withRecentFirst(recent: readonly SearchResult[], found: readonly SearchResult[]): SearchResult[] {
  const seen = new Set(recent.map((r) => r.path));
  return [...recent, ...found.filter((r) => !seen.has(r.path))];
}
