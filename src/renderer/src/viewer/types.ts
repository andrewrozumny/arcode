import type { OpenDiff } from '../bus';

export interface Position {
  line: number;
  character: number;
}

/** Selection with zero-based positions. */
export interface SelectionInfo {
  start: Position;
  end: Position;
  /** Selected text, or null when the selection is empty. */
  text: string | null;
}

export interface ActiveInfo {
  /** Absolute path of the active file. */
  path: string;
  selection: { start: Position; end: Position };
  text: string | null;
}

export interface DiffRequest {
  tabName: string;
  oldPath: string;
  newPath: string;
  oldContent: string;
  newContent: string;
}

export type DiffOutcome =
  | { result: 'saved'; contents: string }
  | { result: 'rejected' }
  /** The tab was closed from outside (`closeTab` / `closeAllDiffTabs`). */
  | { result: 'closed' };

export interface ViewerProps {
  projectRoot: string;
  /** Project-relative path -> git status (porcelain code such as "M", "??", or a word like "modified"). */
  gitStatus?: Record<string, string> | undefined;
  onActiveChange?: ((info: ActiveInfo | null) => void) | undefined;
  /** Called with the project-relative path of a tab ("Reveal in Tree"). */
  onRevealInTree?: ((path: string) => void) | undefined;
  /** Session the pinned Claude feed tab shows; null when this window has none. */
  claudeSessionId?: string | null | undefined;
}

/** A read-only feed tab: a session, or one of its subagents when `agentId` is set. */
export interface FeedTabRequest {
  sessionId: string;
  agentId?: string | undefined;
  title: string;
}

export interface ViewerHandle {
  /**
   * Opens a file (absolute or project-relative). `line` and `column` are 1-based. `diff` shows its
   * diff against HEAD right away ('deleted': the HEAD version of a file gone from disk, read-only).
   */
  open(path: string, line?: number, column?: number, diff?: OpenDiff): void;
  openDiff(request: DiffRequest): Promise<DiffOutcome>;
  /** Opens (or focuses) the Claude panel tab: skills, plugins, MCP, agents, hooks, CLAUDE.md, usage. */
  openClaude(): void;
  /** Opens (or focuses) a closable read-only feed tab next to the pinned feed. */
  openFeed(request: FeedTabRequest): void;
  closeTab(tabName: string): void;
  closeAllDiffTabs(): void;
  closeActive(): void;
  reopenClosed(): void;
  /** Cmd+S: saves the active file (no-op when nothing is dirty). */
  saveActive(): void;
  /** Cmd+E: toggles edit mode of the active file. */
  toggleEdit(): void;
  /** Moves the active tab by `step` (wraps around). */
  stepTab(step: number): void;
}
