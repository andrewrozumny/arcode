/** Pure helpers of the Changes view: folder groups, keyboard stepping, letters and the summary line. */
import type { ChangedFile, GitStatusCode } from '@shared/files';

/** Delay between a git status event and the refetch, so a burst of writes costs one git run. */
export const CHANGES_DEBOUNCE_MS = 150;
/** "Open all diffs" asks first when there are more files than this. */
export const OPEN_ALL_CONFIRM = 20;

export type ChangeRow =
  | { kind: 'dir'; key: string; dir: string; count: number }
  | { kind: 'file'; key: string; file: ChangedFile; name: string };

function compare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * One header row per folder followed by its files. Files at the project root come first, then the
 * folders by path; files in a folder by name.
 */
export function buildChangeRows(files: readonly ChangedFile[]): ChangeRow[] {
  const groups = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const dir = dirOf(file.path);
    const list = groups.get(dir);
    if (list) list.push(file);
    else groups.set(dir, [file]);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : compare(a, b)));
  const rows: ChangeRow[] = [];
  for (const dir of dirs) {
    const list = (groups.get(dir) ?? []).map((file) => ({ file, name: file.path.slice(dir === '' ? 0 : dir.length + 1) }));
    list.sort((a, b) => compare(a.name, b.name));
    rows.push({ kind: 'dir', key: `d:${dir}`, dir, count: list.length });
    for (const { file, name } of list) rows.push({ kind: 'file', key: `f:${file.path}`, file, name });
  }
  return rows;
}

/** Files in display order (the order "Open all diffs" uses). */
export function orderedFiles(rows: readonly ChangeRow[]): ChangedFile[] {
  return rows.flatMap((row) => (row.kind === 'file' ? [row.file] : []));
}

/** Index of the first file row, or -1. */
export function firstFile(rows: readonly ChangeRow[]): number {
  return rows.findIndex((r) => r.kind === 'file');
}

/** The next file row after (delta 1) or before (delta -1) `from`; stays at `from` at either end. */
export function stepFile(rows: readonly ChangeRow[], from: number, delta: 1 | -1): number {
  if (from < 0) return firstFile(rows);
  for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
    if (rows[i]?.kind === 'file') return i;
  }
  return from;
}

export interface ChangeTotals {
  files: number;
  added: number;
  deleted: number;
}

export function totals(files: readonly ChangedFile[]): ChangeTotals {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.added ?? 0;
    deleted += file.deleted ?? 0;
  }
  return { files: files.length, added, deleted };
}

/** One-line summary in the header: "3 files  +12 -4". */
export function summaryLine(t: ChangeTotals): string {
  if (t.files === 0) return 'No changes';
  return `${t.files.toLocaleString('en-US')} file${t.files === 1 ? '' : 's'}`;
}

const LETTERS: Record<GitStatusCode, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', '?': 'U', U: '!' };
const WORDS: Record<GitStatusCode, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  '?': 'Untracked',
  U: 'Conflicted',
};

/** The status letter shown next to a file (U is untracked, as in VS Code; ! is a merge conflict). */
export function statusLetter(code: GitStatusCode): string {
  return LETTERS[code];
}

export function statusWord(code: GitStatusCode): string {
  return WORDS[code];
}

/** The same colour classes as the project tree rows (`git-M`, `git-untracked`, ...). */
export function statusClass(code: GitStatusCode): string {
  return `git-${code === '?' ? 'untracked' : code}`;
}
