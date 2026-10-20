/** Pure helpers of the Find in files panel: rows, keyboard stepping, prefill and the status line. */
import type { GrepFileResult, GrepMatch, GrepResult } from '@shared/files';

export const FIND_DEBOUNCE_MS = 200;
/** Longest editor selection taken over as the query. */
const MAX_PREFILL = 200;

export type FindRow =
  | { kind: 'file'; key: string; file: GrepFileResult; collapsed: boolean }
  | { kind: 'match'; key: string; file: GrepFileResult; match: GrepMatch };

/** File header rows, each followed by its match rows unless the file is collapsed. */
export function buildRows(files: readonly GrepFileResult[], collapsed: ReadonlySet<string>): FindRow[] {
  const rows: FindRow[] = [];
  for (const file of files) {
    const isCollapsed = collapsed.has(file.path);
    rows.push({ kind: 'file', key: `f:${file.path}`, file, collapsed: isCollapsed });
    if (isCollapsed) continue;
    file.matches.forEach((match, i) => rows.push({ kind: 'match', key: `m:${file.path}:${match.line}:${i}`, file, match }));
  }
  return rows;
}

/** Index of the first match row, or -1. */
export function firstMatch(rows: readonly FindRow[]): number {
  return rows.findIndex((r) => r.kind === 'match');
}

/** The next match row after (delta 1) or before (delta -1) `from`; stays at `from` at either end. */
export function stepMatch(rows: readonly FindRow[], from: number, delta: 1 | -1): number {
  if (from < 0) return firstMatch(rows);
  for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
    if (rows[i]?.kind === 'match') return i;
  }
  return from;
}

/** The editor selection as a query: one non-blank line, not too long; null otherwise. */
export function prefillFromSelection(text: string | null | undefined): string | null {
  if (!text || text.length > MAX_PREFILL || /[\r\n]/.test(text) || text.trim() === '') return null;
  return text;
}

const plural = (n: number, word: string): string =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : word.endsWith('ch') ? 'es' : 's'}`;

/** One-line summary under the inputs. */
export function summary(result: GrepResult | null, searching: boolean): string {
  if (searching) return 'Searching…';
  if (!result) return '';
  if (result.error) return result.error;
  if (result.files.length === 0) return result.timedOut ? 'No matches before the time limit' : 'No matches';
  let line = `${plural(result.totalCount, 'match')} in ${plural(result.files.length, 'file')}`;
  if (result.timedOut) line += ' (time limit reached, results incomplete)';
  else if (result.truncated) line += ' (first results only, refine the query)';
  return line;
}

/** Splits a project-relative path into the file name and its folder (empty at the root). */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}
