/** Terminal font size: one value for every tab, remembered in localStorage. */
const FONT_KEY = 'acode.terminal.fontSize';
export const FONT_DEFAULT = 13;
export const FONT_MIN = 8;
export const FONT_MAX = 32;

export function loadFontSize(): number {
  try {
    const stored = Number.parseInt(localStorage.getItem(FONT_KEY) ?? '', 10);
    if (Number.isFinite(stored)) return Math.min(FONT_MAX, Math.max(FONT_MIN, stored));
  } catch {
    // Storage may be unavailable.
  }
  return FONT_DEFAULT;
}

export function saveFontSize(size: number): void {
  try {
    localStorage.setItem(FONT_KEY, String(size));
  } catch {
    // Not persisted; the size still applies for this run.
  }
}
