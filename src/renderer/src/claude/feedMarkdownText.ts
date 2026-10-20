/**
 * Markdown of Claude's replies as the feed renders it. Claude writes for a terminal, where every
 * line break shows and a line that starts with "7." or "•" reads as a list item; strict
 * CommonMark joins such lines into one paragraph. This module bridges the two, and is pure so the
 * rules are covered by tests.
 *
 * - Soft line breaks are kept (`breaks: true`), as Claude Code's terminal shows them.
 * - "•" (and similar) bullets at the start of a line become Markdown list items.
 * - An ordered list that starts at a number other than 1 right under a line of text gets a blank
 *   line before it: CommonMark lets only "1." interrupt a paragraph, so "Next:\n7. Foo" stayed
 *   one run-on paragraph.
 *
 * Fenced code blocks are left exactly as they are.
 */
import { marked } from 'marked';
import type { MarkedOptions } from 'marked';

/** Options of every feed render: GitHub Markdown with the terminal's line breaks. */
export const FEED_MARKED_OPTIONS: MarkedOptions & { async: false } = { gfm: true, breaks: true, async: false };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BULLET_CHAR = /^(\s*)[•●▪◦‣]\s+(?=\S)/;
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+\S/;
/** Leading blockquote markers, "> " or ">> ". */
const QUOTE = /^ {0,3}(?:> ?)+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/** True for a line of paragraph text that a following list line would be glued to. */
function isTextLine(line: string): boolean {
  if (!line.trim()) return false;
  if (LIST_ITEM.test(line)) return false;
  // Tables, headings and html blocks end or contain their own structure.
  return !/^\s*(?:\||#{1,6}\s|<)/.test(line);
}

/** Rewrites terminal-style lists into Markdown lists; see the module comment for the rules. */
export function prepareFeedMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of lines) {
    const fenceMatch = FENCE.exec(raw);
    if (fence !== null) {
      out.push(raw);
      // A fence closes with at least as many of the same characters.
      if (fenceMatch?.[1] && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !raw.trim().slice(fenceMatch[1].length).trim()) fence = null;
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      out.push(raw);
      continue;
    }
    // Inside a quote the same rules apply to the text after the "> " markers.
    const quote = QUOTE.exec(raw)?.[0] ?? '';
    const body = raw.slice(quote.length);
    const line = body.replace(BULLET_CHAR, '$1- ');
    const ordered = ORDERED.exec(line);
    const previous = out[out.length - 1];
    const before = previous !== undefined && previous.startsWith(quote) ? previous.slice(quote.length) : undefined;
    const startsList = (ordered && ordered[1] !== '1') || (line !== body && /^\s{0,3}- /.test(line));
    if (startsList && before !== undefined && isTextLine(before) && !/^\s/.test(before)) out.push(quote.trimEnd());
    out.push(quote + line);
  }
  return out.join('\n');
}

/** Feed Markdown to HTML, not yet sanitized (FeedMarkdown runs it through DOMPurify). */
export function feedMarkdownHtml(source: string): string {
  return marked.parse(prepareFeedMarkdown(source), FEED_MARKED_OPTIONS);
}
