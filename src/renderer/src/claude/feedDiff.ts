/**
 * Line diffs for the Claude feed's edit cards: from an edit's old and new text when nothing better
 * is known, or from the patch Claude Code reported (which carries real line numbers). Pure.
 */
import type { FeedHunk } from '@shared/claude';

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the file, when known: the new file's for context and added lines, the old one's for removed lines. */
  line: number | null;
}

/** A gap between hunks, or context left out of a long run of unchanged lines. */
export interface DiffGap {
  kind: 'gap';
}

export type DiffRow = DiffLine | DiffGap;

/** Unchanged lines kept around each change. */
export const CONTEXT = 3;
/** Above this many cells (old lines times new lines) the LCS table is skipped: old block out, new block in. */
const MAX_CELLS = 2_000_000;

function splitText(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line operations turning `a` into `b`, by a longest common subsequence over the changed middle. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitText(oldText);
  const b = splitText(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: 'context', text: a[i] ?? '', line: null });
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    for (const text of midA) out.push({ kind: 'removed', text, line: null });
    for (const text of midB) out.push({ kind: 'added', text, line: null });
  } else {
    // lcs[i * (m + 1) + j]: length of the LCS of midA[i..] and midB[j..].
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          midA[i] === midB[j] ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'context', text: midA[i] ?? '', line: null });
        i++;
        j++;
      } else if (i < n && (j === m || (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))) {
        // On a tie removals go first, like unified diffs show a change.
        out.push({ kind: 'removed', text: midA[i] ?? '', line: null });
        i++;
      } else {
        out.push({ kind: 'added', text: midB[j] ?? '', line: null });
        j++;
      }
    }
  }
  for (let i = a.length - tail; i < a.length; i++) out.push({ kind: 'context', text: a[i] ?? '', line: null });
  return out;
}

/** Lines of a reported patch with their line numbers; hunks are separated by gaps. */
export function patchRows(hunks: readonly FeedHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((hunk, index) => {
    if (index > 0) rows.push({ kind: 'gap' });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const mark = raw.charAt(0);
      const text = raw.slice(1);
      if (mark === '+') rows.push({ kind: 'added', text, line: newLine++ });
      else if (mark === '-') rows.push({ kind: 'removed', text, line: oldLine++ });
      else if (mark === '\\') continue;
      else {
        rows.push({ kind: 'context', text, line: newLine++ });
        oldLine++;
      }
    }
  });
  return rows;
}

/** Keeps CONTEXT unchanged lines around each change and replaces longer unchanged runs with a gap. */
export function withContext(lines: readonly DiffLine[], context = CONTEXT): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.kind === 'context') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = false;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (skipped && rows.length > 0) rows.push({ kind: 'gap' });
      skipped = false;
      rows.push(line);
    } else skipped = true;
  });
  return rows;
}

/** Number of added and removed lines. */
export function diffStats(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'added') added++;
    else if (row.kind === 'removed') removed++;
  }
  return { added, removed };
}

/** All lines of a new file as added lines, numbered from 1. */
export function addedRows(content: string): DiffLine[] {
  return splitText(content).map((text, i) => ({ kind: 'added', text, line: i + 1 }));
}
