/** Composer prompt history, kept in local storage as a convenience. */

const HISTORY_KEY = 'acode.composer.history';
const HISTORY_LIMIT = 50;

export function loadHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)));
  } catch {
    // Storage may be unavailable; history is a convenience only.
  }
}

/** Appends an entry, dropping an immediate duplicate and keeping the newest `limit` entries. */
export function pushHistory(history: string[], entry: string, limit: number = HISTORY_LIMIT): string[] {
  const next = history[history.length - 1] === entry ? history : [...history, entry];
  return next.slice(-limit);
}
