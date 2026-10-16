/** Small fuzzy matcher for the project switcher. Pure, no DOM. */
import type { ProjectEntry } from '@shared/app';

/**
 * Scores `query` as a subsequence of `text` (case-insensitive). Higher is better,
 * null when not all query characters occur in order. Rewards consecutive runs,
 * matches at word starts and matches near the beginning.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const prev = found > 0 ? text[found - 1] : '';
    const atWordStart = found === 0 || /[\s/_.-]/.test(prev ?? '') || (/[a-z]/.test(prev ?? '') && /[A-Z]/.test(text[found] ?? ''));
    run = found === ti && ti > 0 ? run + 1 : 0;
    score += 1 + run * 3 + (atWordStart ? 4 : 0) - Math.min(found - ti, 10) * 0.2;
    ti = found + 1;
  }
  // Prefer shorter texts and earlier first matches.
  score -= t.length * 0.01;
  if (t.startsWith(q)) score += 10;
  else if (t.includes(q)) score += 5;
  return score;
}

/** Best score of a project over its name, slug and path (path weighs less). */
export function projectScore(query: string, project: ProjectEntry): number | null {
  const candidates: [string | undefined, number][] = [
    [project.name, 1],
    [project.slug, 1],
    [project.root, 0.6],
  ];
  let best: number | null = null;
  for (const [text, weight] of candidates) {
    if (!text) continue;
    const score = fuzzyScore(query, text);
    if (score !== null && (best === null || score * weight > best)) best = score * weight;
  }
  return best;
}

/** Filters and ranks projects; with an empty query the input order is kept. */
export function filterProjects(query: string, projects: readonly ProjectEntry[]): ProjectEntry[] {
  if (!query.trim()) return [...projects];
  return projects
    .map((project, index) => ({ project, index, score: projectScore(query, project) }))
    .filter((item): item is { project: ProjectEntry; index: number; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.project);
}

/** Recent first, then registry projects not already listed as recent. */
export function mergeProjects(recent: readonly ProjectEntry[], registry: readonly ProjectEntry[]): ProjectEntry[] {
  const seen = new Set(recent.map((p) => p.root));
  return [...recent, ...registry.filter((p) => !seen.has(p.root))];
}
