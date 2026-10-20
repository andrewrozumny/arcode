/**
 * Answers Claude Code's terminal prompts from the feed by typing into the Claude tab's pty, the
 * way a user would. Pure apart from `sendKeys`'s timer, so the mapping is covered by tests.
 *
 * What Claude Code 2.1's TUI expects, checked against the real CLI under a pty:
 *
 * - AskUserQuestion shows one tab per question (plus a Submit tab when there are several
 *   questions or a multi-select one). Options are numbered; "Type something" is the number after
 *   the last option.
 *   - Single select: the option's number picks it and moves to the next tab. A lone single-select
 *     question is submitted right away.
 *   - Multi select: a number toggles that option without moving; Right arrow goes to the next tab.
 *   - "Type something" in a single-select question: its number focuses a text field; the text and
 *     Enter answer the question. In a multi-select question the number only toggles a checkbox, so
 *     a typed answer is left to the terminal.
 *   - The Submit tab reviews the answers; "1" submits them.
 * - Plan approval and permission prompts are numbered lists; the number picks the option.
 * - Keys written in one chunk arrive as one input event and are taken as typed text, not as
 *   separate key presses, so every key is written on its own with a short pause.
 */
import type { FeedQuestion } from '@shared/claude';

/** Pause between two writes, so the TUI handles each as its own key press. */
export const KEY_GAP_MS = 150;
export const RIGHT = '\u001b[C';
export const ENTER = '\r';
/** Longest typed answer the feed sends. */
const OTHER_CHARS = 2000;

/** The user's answer to one question: picked options (0-based) or typed text. */
export type QuestionAnswer = { kind: 'options'; picks: readonly number[] } | { kind: 'other'; text: string };

/** Typed text as one line: no control characters (Enter would submit early, Esc would cancel). */
export function cleanAnswerText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, OTHER_CHARS);
}

/**
 * Key presses that give `answers` to `questions`, each to be written on its own; null when the
 * feed cannot answer them reliably (a missing answer, a typed answer to a multi-select question,
 * more options than number keys).
 */
export function questionKeys(questions: readonly FeedQuestion[], answers: readonly (QuestionAnswer | undefined)[]): string[] | null {
  if (questions.length === 0 || answers.length !== questions.length) return null;
  const steps: string[] = [];
  for (const [i, question] of questions.entries()) {
    const answer = answers[i];
    const count = question.options.length;
    // "Type something" takes the number after the options; both must be single keys.
    if (!answer || count === 0 || count + 1 > 9) return null;
    if (answer.kind === 'other') {
      const text = cleanAnswerText(answer.text);
      if (question.multiSelect || !text) return null;
      steps.push(String(count + 1), text, ENTER);
      continue;
    }
    const picks = [...new Set(answer.picks)].sort((a, b) => a - b);
    if (picks.length === 0 || picks.some((pick) => !Number.isInteger(pick) || pick < 0 || pick >= count)) return null;
    if (!question.multiSelect) {
      if (picks.length !== 1) return null;
      steps.push(String((picks[0] ?? 0) + 1));
      continue;
    }
    for (const pick of picks) steps.push(String(pick + 1));
    steps.push(RIGHT);
  }
  // Several questions or a multi-select one end on the review tab; a lone single-select question is already sent.
  if (questions.length > 1 || questions[0]?.multiSelect) steps.push('1');
  return steps;
}

/** One numbered option of a prompt on the terminal screen. */
export interface ScreenOption {
  /** The key that picks it: its number. */
  key: string;
  label: string;
  /** The option the TUI's cursor is on. */
  selected: boolean;
  /** Picking it opens a text field in the terminal (feedback for Claude, a typed answer). */
  needsText: boolean;
}

/** A numbered choice Claude Code shows at the bottom of its screen: a permission or a plan approval. */
export interface ScreenPrompt {
  title: string | null;
  options: ScreenOption[];
}

const SEPARATOR = /^\s*─{8,}/;
const RULE = /^\s*[─╌━═]{8,}/;
const OPTION = /^(\s*)(❯\s+)?(\d)\.\s+(\S.*)$/;
const NEEDS_TEXT = /tell claude|what to change|differently|type something|feedback/i;

/**
 * The numbered prompt at the bottom of a Claude Code screen, from the visible lines of its
 * terminal: the last run of options 1..n after the last separator line, one of them under the
 * `❯` cursor. Lines of Claude's own output above the separator (a plan's numbered steps) are not
 * a prompt. `cols` tells wrapped option labels from hints under them.
 */
export function parseScreenPrompt(lines: readonly string[], cols: number): ScreenPrompt | null {
  const rows = lines.map((line) => line.replace(/\s+$/, ''));
  let from = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (SEPARATOR.test(rows[i] ?? '')) {
      from = i + 1;
      break;
    }
  }
  const blocks: { first: number; options: ScreenOption[] }[] = [];
  let current: { first: number; options: ScreenOption[]; indent: number; last: string } | null = null;
  const close = (): void => {
    if (current && current.options.length >= 2 && current.options.some((o) => o.selected)) blocks.push({ first: current.first, options: current.options });
    current = null;
  };
  for (let i = from; i < rows.length; i++) {
    const row = rows[i] ?? '';
    const match = OPTION.exec(row);
    if (match) {
      const number = Number(match[3]);
      const option: ScreenOption = { key: String(number), label: (match[4] ?? '').trim(), selected: Boolean(match[2]), needsText: false };
      if (number === 1) {
        close();
        current = { first: i, options: [option], indent: (match[1] ?? '').length, last: row };
      } else if (current && number === current.options.length + 1) {
        current.options.push(option);
        current.last = row;
      } else close();
      continue;
    }
    if (!current) continue;
    if (!row.trim()) {
      close();
      continue;
    }
    const indent = /^\s*/.exec(row)?.[0].length ?? 0;
    if (indent <= current.indent) {
      close();
      continue;
    }
    // A label the TUI wrapped: the previous line was full and this one continues it.
    const word = /\S+/.exec(row)?.[0] ?? '';
    const option = current.options[current.options.length - 1];
    if (option && current.last.length + 1 + word.length > cols - 2 && OPTION.test(current.last)) option.label = `${option.label} ${row.trim()}`;
    current.last = row;
  }
  close();
  const found = blocks[blocks.length - 1];
  if (!found) return null;
  for (const option of found.options) option.needsText = NEEDS_TEXT.test(option.label);
  // The title: the text lines right above the first option, up to a rule.
  const title: string[] = [];
  for (let i = found.first - 1; i >= from && title.length < 3; i--) {
    const row = rows[i] ?? '';
    if (!row.trim()) {
      if (title.length > 0) break;
      continue;
    }
    if (RULE.test(row)) break;
    title.unshift(row.trim());
  }
  return { title: title.length > 0 ? title.join(' ') : null, options: found.options };
}

/** True when the screen shows `question`: a guard that the TUI is on the question the feed answers. */
export function screenShows(lines: readonly string[], text: string): boolean {
  const probe = text.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!probe) return false;
  return lines.some((line) => line.includes(probe));
}

/** Writes each step on its own, `gapMs` apart. */
export async function sendKeys(
  write: (data: string) => void,
  steps: readonly string[],
  gapMs = KEY_GAP_MS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
): Promise<void> {
  for (const [i, step] of steps.entries()) {
    if (i > 0) await wait(gapMs);
    write(step);
  }
}
