import type { PtyId } from '@shared/ipc';
import type { ClaudeStatus, TerminalPaneState } from '@shared/terminal';

export type { PersistedTab, TerminalPaneState } from '@shared/terminal';

export type TabKind = 'shell' | 'claude' | 'gate';

export interface ClaudeTabInfo {
  sessionId: string;
  name: string;
  /** True when the tab continues an earlier session (`claude --resume`). */
  resumed: boolean;
}

export type GateState = 'running' | 'passed' | 'failed';

/** Live tab model held by the pane. */
export interface TerminalTab {
  id: string;
  kind: TabKind;
  title: string;
  /** Dock column: 1 is the right column of a split dock; absent means the left (or only) column. */
  column?: 0 | 1 | undefined;
  ptyId?: PtyId;
  claude?: ClaudeTabInfo;
  gate?: { target: string; state: GateState };
  /** Latest Claude Code status for this tab. */
  claudeStatus?: ClaudeStatus | undefined;
  /** Reason Claude waits for the user, when it does. */
  waitingFor?: string | undefined;
  /** Model id of the session in this tab (e.g. `claude-opus-5-5`), from its transcript. */
  claudeModel?: string | undefined;
  /** Marketing name of that model (e.g. `Opus 5.5`), when Claude Code wrote one. */
  claudeModelName?: string | undefined;
  /** Restored tab with an earlier session: ask whether to continue it or start a new one. */
  resumeChoice?: boolean | undefined;
  /** Status text and color announced by the CLI through OSC 21337. */
  indicator?: { color?: string | undefined; text?: string | undefined };
  /** Latest terminal title announced through OSC 0/2. */
  oscTitle?: string;
  exited?: boolean;
}

export const EMPTY_PANE_STATE: TerminalPaneState = { tabs: [], activeTabId: null, composerOpen: false };
