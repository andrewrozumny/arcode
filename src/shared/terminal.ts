/** IPC contract of the terminal module: channels and payloads shared by main, preload and renderer. */

import { isRecord } from './guards';
import type { PtyId } from './ipc';

export const TerminalChannel = {
  ResolveFile: 'terminal:resolveFile',
  ClipboardInfo: 'terminal:clipboardInfo',
  SavePastedImage: 'terminal:savePastedImage',
  HasChildren: 'terminal:hasChildren',
  SessionExists: 'terminal:sessionExists',
  ClaudeSnapshot: 'terminal:claudeSnapshot',
  ClaudeStatus: 'terminal:claudeStatus',
  Attention: 'terminal:attention',
  TabTitles: 'terminal:tabTitles',
  FocusPty: 'terminal:focusPty',
} as const;

/** Status values of a Claude Code process as written to ~/.claude/sessions/<pid>.json, plus `ended`. */
export type ClaudeStatus = 'busy' | 'idle' | 'waiting' | 'shell' | 'ended';

export interface ClaudeStatusEvent {
  pid: number;
  sessionId: string | null;
  status: ClaudeStatus;
  /** Reason Claude waits for the user (permission prompt etc.). */
  waitingFor: string | null;
  name: string | null;
  cwd: string | null;
  /** Latest model id in the transcript (e.g. `claude-opus-5-5`): the newest assistant turn or `/model` switch. */
  model: string | null;
  /** Marketing name Claude Code wrote with the switch (e.g. `Opus 5.5`), when known. */
  modelName: string | null;
  /** Pty whose shell is an ancestor of the process, when it could be determined. */
  ptyId: PtyId | null;
}

export interface ClipboardInfo {
  hasImage: boolean;
  hasText: boolean;
}

export interface AttentionRequest {
  /** Number of tabs waiting for the user that are not currently being looked at. */
  waiting: number;
}

/** Title of the terminal tab a pty belongs to, so a notification can name the tab. */
export interface TabTitle {
  ptyId: PtyId;
  title: string;
}

/** Most tab titles main keeps per window, and the longest title it keeps. */
export const MAX_TAB_TITLES = 100;
export const MAX_TAB_TITLE_LENGTH = 200;

/** Turns untrusted tab titles from a renderer into a ptyId to title map (bad entries are dropped). */
export function sanitizeTabTitles(value: unknown): Map<PtyId, string> {
  const titles = new Map<PtyId, string>();
  if (!Array.isArray(value)) return titles;
  for (const raw of value.slice(0, MAX_TAB_TITLES)) {
    if (!isRecord(raw) || typeof raw.ptyId !== 'number' || !Number.isInteger(raw.ptyId)) continue;
    if (typeof raw.title !== 'string') continue;
    const title = raw.title.trim().slice(0, MAX_TAB_TITLE_LENGTH);
    if (title) titles.set(raw.ptyId, title);
  }
  return titles;
}

/** Terminal-specific part of the API exposed to the renderer as `window.acode.terminal`. */
export interface TerminalApi {
  /**
   * Resolves a path from terminal output against the project root (`~` and absolute paths allowed)
   * and returns the absolute path when it is an existing regular file, otherwise null.
   */
  resolveFile(path: string, projectRoot: string): Promise<string | null>;
  clipboardInfo(): Promise<ClipboardInfo>;
  /** Stores image bytes under the app data folder and returns the absolute file path. */
  savePastedImage(bytes: Uint8Array, mimeType: string): Promise<string>;
  /** True when the shell of the pty has running child processes. */
  hasChildren(ptyId: PtyId): Promise<boolean>;
  /** True when a Claude Code transcript with this session id exists, i.e. `--resume` will work. */
  sessionExists(sessionId: string): Promise<boolean>;
  claudeSnapshot(): Promise<ClaudeStatusEvent[]>;
  onClaudeStatus(listener: (event: ClaudeStatusEvent) => void): () => void;
  /** Dock bounce and badge for tabs waiting for the user while the window is in the background. */
  attention(request: AttentionRequest): void;
  /** Titles of the tabs that have a pty, used to name the tab in a notification. */
  tabTitles(titles: TabTitle[]): void;
  /** A notification was clicked: show and focus the terminal tab of this pty. */
  onFocusPty(listener: (ptyId: PtyId) => void): () => void;
  /** Absolute path of a dropped File object. */
  pathForFile(file: File): string;
}

/** Tab data worth keeping across restarts (no pty ids, no live status). */
export interface PersistedTab {
  id: string;
  kind: 'shell' | 'claude';
  title: string;
  claude?: { sessionId: string; name: string };
}

/** Terminal tabs of one project window, saved per project and restored on the next start. */
export interface TerminalPaneState {
  tabs: PersistedTab[];
  activeTabId: string | null;
  composerOpen: boolean;
}

const MAX_SAVED_TABS = 50;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;


/** Turns untrusted saved data into a valid pane state; undefined when nothing usable is left. */
export function sanitizeTerminalState(value: unknown): TerminalPaneState | undefined {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return undefined;
  const tabs: PersistedTab[] = [];
  for (const raw of value.tabs.slice(0, MAX_SAVED_TABS)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) continue;
    const title = typeof raw.title === 'string' ? raw.title.slice(0, 200) : '';
    if (!title) continue;
    if (raw.kind === 'shell') {
      tabs.push({ id: raw.id, kind: 'shell', title });
    } else if (raw.kind === 'claude' && isRecord(raw.claude)) {
      const { sessionId, name } = raw.claude;
      if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) continue;
      tabs.push({
        id: raw.id,
        kind: 'claude',
        title,
        claude: { sessionId, name: typeof name === 'string' ? name.slice(0, 200) : title },
      });
    }
  }
  const activeTabId =
    typeof value.activeTabId === 'string' && tabs.some((t) => t.id === value.activeTabId) ? value.activeTabId : null;
  return { tabs, activeTabId, composerOpen: value.composerOpen === true };
}
