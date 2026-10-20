/**
 * Per-project editor state kept in state.json: the open viewer file tabs and the recently
 * opened files, plus the editor settings the renderer needs. Pure; shared by main and renderer.
 */
import { isRecord } from './guards';

/** Recent files kept per project. */
export const MAX_RECENT_FILES = 30;
/** Viewer file tabs restored per project; more than this is almost certainly noise. */
export const MAX_VIEWER_TABS = 100;

/** File tabs of one project window, restored on the next start. Diff and IDE tabs are not kept. */
export interface ViewerTabsState {
  /** Project-relative paths in tab order. */
  files: string[];
  /** Project-relative path of the active tab; null when the pinned feed tab was active. */
  active: string | null;
}

/** Settings of the editor that the renderer reads (state.json `settings`, with defaults applied). */
export interface EditorSettings {
  /** Save files about a second after the last change, on blur and when a tab is left. */
  autosave: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { autosave: true };

/**
 * A project-relative path as the viewer uses it: forward slashes, no leading slash, no `..`
 * or empty segments. The main process still checks every path against the root on use.
 */
export function isProjectRelative(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 4096) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function cleanPathList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isProjectRelative(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** Valid viewer tabs from whatever was on disk or came over IPC; undefined when unusable. */
export function sanitizeViewerTabs(value: unknown): ViewerTabsState | undefined {
  if (!isRecord(value)) return undefined;
  const files = cleanPathList(value.files, MAX_VIEWER_TABS);
  const active = typeof value.active === 'string' && files.includes(value.active) ? value.active : null;
  return { files, active };
}

/** Valid recent files (most recent first, unique, capped). */
export function sanitizeRecentFiles(value: unknown): string[] {
  return cleanPathList(value, MAX_RECENT_FILES);
}

/** Moves `path` to the front of the most-recently-used list, capped at `cap`. */
export function updateRecentFiles(list: readonly string[], path: string, cap = MAX_RECENT_FILES): string[] {
  return [path, ...list.filter((item) => item !== path)].slice(0, cap);
}

