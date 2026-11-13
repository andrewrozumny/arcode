/**
 * What the user has typed into Claude Code's prompt and not sent yet, read from the screen. Claude
 * Code draws its prompt as a `❯` (older versions `>`, sometimes inside a `│` box) between two rules;
 * an empty prompt shows a dim suggestion ("Try ..."), which is not the user's text.
 */

/** One screen row: its characters and, per character, whether it is drawn dim. */
export interface ScreenRow {
  chars: string[];
  dim: boolean[];
}

const PROMPT = /^[\s│|]*[❯>]\s?/u;
const RULE = /^[\s│|]*[─━—-]{8,}/u;

/** The undimmed text after the last prompt marker on screen, with its continuation rows; '' when empty. */
export function promptDraft(rows: readonly ScreenRow[]): string {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = (rows[i]?.chars ?? []).join('');
    if (PROMPT.test(text)) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';
  const parts: string[] = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    const text = row.chars.join('');
    if (i > start && (RULE.test(text) || PROMPT.test(text))) break;
    const skip = i === start ? (PROMPT.exec(text)?.[0].length ?? 0) : 0;
    let line = '';
    let width = 0;
    for (let c = 0; c < row.chars.length; c++) {
      const ch = row.chars[c] ?? '';
      if (width >= skip && !row.dim[c]) line += ch;
      width += ch.length;
    }
    parts.push(line.replace(/[\s│|]+$/u, '').replace(/^\u00a0/u, ''));
  }
  return parts.join('\n').trim();
}
