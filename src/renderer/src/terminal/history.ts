/** Composer prompt history, per project, kept in local storage as a convenience. */

const LEGACY_KEY = 'acode.composer.history';
const HISTORY_LIMIT = 200;

function keyFor(projectRoot: string): string {
  return `${LEGACY_KEY}:${projectRoot}`;
}

function read(key: string): string[] | null {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return null;
    const raw: unknown = JSON.parse(stored);
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(-HISTORY_LIMIT) : [];
  } catch {
    return null;
  }
}

/** The project's history; a project without one starts from the old shared history. */
export function loadHistory(projectRoot: string): string[] {
  return read(keyFor(projectRoot)) ?? read(LEGACY_KEY) ?? [];
}

export function saveHistory(projectRoot: string, history: string[]): void {
  try {
    localStorage.setItem(keyFor(projectRoot), JSON.stringify(history.slice(-HISTORY_LIMIT)));
  } catch {
    // Storage may be unavailable; history is a convenience only.
  }
}

/** Appends an entry, moving an earlier copy to the end and keeping the newest `limit` entries. */
export function pushHistory(history: string[], entry: string, limit: number = HISTORY_LIMIT): string[] {
  return [...history.filter((item) => item !== entry), entry].slice(-limit);
}

/** Newest first, entries containing every word of `query` (case-insensitive). */
export function searchHistory(history: string[], query: string, limit = 30): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = history[i] ?? '';
    const lower = entry.toLowerCase();
    if (words.every((word) => lower.includes(word))) out.push(entry);
  }
  return out;
}
