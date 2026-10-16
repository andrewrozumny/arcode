import type { SearchRange } from '@shared/files';

export interface FuzzyHit {
  score: number;
  /** Matched character positions in the text. */
  positions: number[];
}

const MATCH = 16;
const BOUNDARY_BONUS = 24;
const CONSECUTIVE_BONUS = 20;
const START_BONUS = 12;
const GAP_PENALTY = 2;
const NEG = -1e9;

function isSeparator(ch: string): boolean {
  return ch === '/' || ch === '.' || ch === '_' || ch === '-' || ch === ' ';
}

function boundaryAt(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  if (isSeparator(prev)) return true;
  const ch = text[i] ?? '';
  return prev >= 'a' && prev <= 'z' && ch >= 'A' && ch <= 'Z';
}

/**
 * Subsequence match of `queryLower` against `text` (case-insensitive) maximising a score:
 * consecutive runs and word-boundary starts score higher, gaps cost. Returns null when not a subsequence.
 */
export function fuzzyMatch(text: string, queryLower: string): FuzzyHit | null {
  const n = text.length;
  const m = queryLower.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n) return null;
  const lower = text.toLowerCase();

  // Quick subsequence rejection.
  let qi = 0;
  for (let i = 0; i < n && qi < m; i++) if (lower[i] === queryLower[qi]) qi++;
  if (qi < m) return null;

  // dp[j * n + i]: best score with query[j] matched at text[i]; back[...]: previous matched index.
  const dp = new Float64Array(m * n).fill(NEG);
  const back = new Int32Array(m * n).fill(-1);
  const at = (j: number, i: number): number => dp[j * n + i] ?? NEG;

  for (let j = 0; j < m; j++) {
    // Running maximum of dp[j-1][k] + GAP*k over k < i, so a linear gap cost is O(1) per cell.
    let bestVal = NEG;
    let bestIdx = -1;
    for (let i = 0; i < n; i++) {
      if (j > 0 && i > 0) {
        const prev = at(j - 1, i - 1);
        if (prev > NEG / 2 && prev + GAP_PENALTY * (i - 1) > bestVal) {
          bestVal = prev + GAP_PENALTY * (i - 1);
          bestIdx = i - 1;
        }
      }
      if (lower[i] !== queryLower[j]) continue;
      const base = MATCH + (boundaryAt(text, i) ? BOUNDARY_BONUS : 0) + (i === 0 ? START_BONUS : 0);
      if (j === 0) {
        dp[i] = base;
        continue;
      }
      let candidate = NEG;
      let from = -1;
      if (bestIdx >= 0) {
        candidate = bestVal - GAP_PENALTY * (i - 1);
        from = bestIdx;
      }
      if (i > 0 && at(j - 1, i - 1) > NEG / 2) {
        const consecutive = at(j - 1, i - 1) + CONSECUTIVE_BONUS;
        if (consecutive >= candidate) {
          candidate = consecutive;
          from = i - 1;
        }
      }
      if (from < 0) continue;
      dp[j * n + i] = base + candidate;
      back[j * n + i] = from;
    }
  }

  let bestScore = NEG;
  let end = -1;
  for (let i = 0; i < n; i++) {
    if (at(m - 1, i) > bestScore) {
      bestScore = at(m - 1, i);
      end = i;
    }
  }
  if (end < 0) return null;
  const positions: number[] = [];
  let cur = end;
  for (let j = m - 1; j >= 0 && cur >= 0; j--) {
    positions.unshift(cur);
    cur = back[j * n + cur] ?? -1;
  }
  return { score: bestScore, positions };
}

export interface ScoredPath {
  score: number;
  positions: number[];
}

/**
 * Scores a project-relative path. A match inside the file name always outranks a match that
 * only works across the directory part.
 */
export function scorePath(path: string, queryLower: string): ScoredPath | null {
  const baseStart = path.lastIndexOf('/') + 1;
  const base = path.slice(baseStart);
  const inBase = fuzzyMatch(base, queryLower);
  if (inBase) {
    let score = 10000 + inBase.score;
    const idx = base.toLowerCase().indexOf(queryLower);
    if (idx >= 0) {
      score += 400;
      if (idx === 0) score += 300;
      if ((base.split('.')[0] ?? '').toLowerCase() === queryLower) score += 500;
    }
    return { score, positions: inBase.positions.map((p) => p + baseStart) };
  }
  const inPath = fuzzyMatch(path, queryLower);
  if (!inPath) return null;
  return { score: inPath.score, positions: inPath.positions };
}

/** Collapses sorted positions into half-open ranges. */
export function positionsToRanges(positions: number[]): SearchRange[] {
  const ranges: SearchRange[] = [];
  for (const p of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === p) last.end = p + 1;
    else ranges.push({ start: p, end: p + 1 });
  }
  return ranges;
}
