/**
 * Helpers for the Markdown split view: source line numbers on rendered blocks, the mapping between
 * editor lines and preview offsets used for scroll sync, and the remembered mode. Free of DOM types
 * (storage is passed in) so it runs in Vitest.
 */

export type MarkdownMode = 'preview' | 'source' | 'split';

/** Delay between the last keystroke and the live preview re-render in split mode. */
export const LIVE_PREVIEW_DELAY_MS = 150;

/** Below this viewer width the split view stacks the preview under the editor. */
export const SPLIT_MIN_WIDTH_PX = 900;

/** Token types that render nothing; they get no line marker. */
const SILENT_TOKENS = new Set(['space', 'def']);

/**
 * 1-based start line of each top-level token. Marked's top-level `raw` strings join back into the
 * (newline normalized) source, so counting newlines gives each block its first line.
 */
export function blockStartLines(tokens: readonly { raw: string }[]): number[] {
  const lines: number[] = [];
  let line = 1;
  for (const token of tokens) {
    const leading = /^\n*/.exec(token.raw)?.[0].length ?? 0;
    lines.push(line + leading);
    line += countNewlines(token.raw);
  }
  return lines;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count += 1;
  return count;
}

/** True when a token of this type should carry a `data-line` marker. */
export function marksLine(type: string): boolean {
  return !SILENT_TOKENS.has(type);
}

/** Adds `data-line` to the first opening tag of a rendered block; HTML without a leading tag is returned as is. */
export function withSourceLine(html: string, line: number): string {
  return html.replace(/^(\s*<[a-z][a-z0-9-]*)(?=[\s/>])/i, `$1 data-line="${line}"`);
}

/** A point that ties a (fractional, 1-based) source line to a vertical offset in px. */
export interface Anchor {
  line: number;
  top: number;
}

/**
 * Anchors for a rendered document: the start, one per marked block and the end. Blocks are sorted
 * by line and any block that would move the offset backwards is dropped, so the mapping stays
 * monotonic. With no blocks this degrades to a plain line ratio.
 */
export function buildAnchors(blocks: readonly Anchor[], totalLines: number, height: number): Anchor[] {
  const end = { line: Math.max(1, totalLines) + 1, top: Math.max(0, height) };
  const anchors: Anchor[] = [{ line: 1, top: 0 }];
  const sorted = [...blocks].filter((b) => Number.isFinite(b.line) && Number.isFinite(b.top)).sort((a, b) => a.line - b.line);
  for (const block of sorted) {
    const last = anchors[anchors.length - 1] as Anchor;
    if (block.line < last.line || block.top < last.top || block.line >= end.line || block.top > end.top) continue;
    if (block.line === last.line) {
      // Same line as the start anchor (a block on line 1): keep the block's offset.
      last.top = block.top;
      continue;
    }
    anchors.push({ line: block.line, top: block.top });
  }
  anchors.push(end);
  return anchors;
}

/** Offset for a fractional source line, interpolated between the surrounding anchors. */
export function topForLine(anchors: readonly Anchor[], line: number): number {
  return interpolate(anchors, line, 'line', 'top');
}

/** Fractional source line for an offset, the inverse of `topForLine`. */
export function lineForTop(anchors: readonly Anchor[], top: number): number {
  return interpolate(anchors, top, 'top', 'line');
}

function interpolate(anchors: readonly Anchor[], value: number, from: keyof Anchor, to: keyof Anchor): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!first || !last) return 0;
  if (value <= first[from]) return first[to];
  if (value >= last[from]) return last[to];
  // Last anchor at or before the value (binary search).
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((anchors[mid] as Anchor)[from] <= value) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo] as Anchor;
  const b = anchors[hi] as Anchor;
  const span = b[from] - a[from];
  return span <= 0 ? a[to] : a[to] + ((value - a[from]) / span) * (b[to] - a[to]);
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const modeKey = (ext: string): string => `arcode.viewer.markdownMode.${ext || 'md'}`;
const FRACTION_KEY = 'arcode.viewer.markdownSplit';

/** The remembered mode for a file extension; Preview when nothing (valid) is stored. */
export function loadMarkdownMode(storage: StorageLike | null, ext: string): MarkdownMode {
  try {
    const value = storage?.getItem(modeKey(ext));
    return value === 'source' || value === 'split' || value === 'preview' ? value : 'preview';
  } catch {
    return 'preview';
  }
}

export function saveMarkdownMode(storage: StorageLike | null, ext: string, mode: MarkdownMode): void {
  try {
    storage?.setItem(modeKey(ext), mode);
  } catch {
    // storage full or blocked: the mode is just not remembered
  }
}

/** Share of the split taken by the editor, kept between 0.2 and 0.8. */
export function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.5;
}

export function loadSplitFraction(storage: StorageLike | null): number {
  try {
    const raw = storage?.getItem(FRACTION_KEY);
    return raw ? clampFraction(Number.parseFloat(raw)) : 0.5;
  } catch {
    return 0.5;
  }
}

export function saveSplitFraction(storage: StorageLike | null, value: number): void {
  try {
    storage?.setItem(FRACTION_KEY, String(clampFraction(value)));
  } catch {
    // not remembered
  }
}
