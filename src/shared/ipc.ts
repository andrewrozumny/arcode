/** IPC channel names and payload types shared by main, preload and renderer. */
import type { ClaudeApi } from './claude';
import type { FilesApi } from './files';
import type { IdeApi } from './ide-ipc';
import type { TerminalApi } from './terminal';
import type { ViewerApi } from './viewer';

export const IpcChannel = {
  PtyCreate: 'pty:create',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  PtyData: 'pty:data',
  PtyExit: 'pty:exit',
  ClipboardRead: 'clipboard:read',
  ClipboardWrite: 'clipboard:write',
  MenuNewTab: 'menu:new-tab',
  MenuCloseTab: 'menu:close-tab',
  MenuSelectTab: 'menu:select-tab',
  AppReady: 'app:first-render',
} as const;

export type PtyId = number;

export interface PtyCreateOptions {
  cols: number;
  rows: number;
  /** Working directory; defaults to the project folder chosen by main. */
  cwd?: string | undefined;
  /** Extra environment for this pty, applied after the cleaned parent env. */
  extraEnv?: Record<string, string> | undefined;
  /** Display name of the tab the pty belongs to (diagnostics only). */
  name?: string | undefined;
}

export interface PtyCreateResult {
  id: PtyId;
  /** OS pid of the shell. */
  pid: number;
  cwd: string;
  shell: string;
}

export interface PtyDataEvent {
  id: PtyId;
  data: string;
}

export interface PtyExitEvent {
  id: PtyId;
  exitCode: number;
  signal?: number;
}

/** Direction for tab switching menu items: -1 previous, +1 next. */
export type TabStep = -1 | 1;

/** API exposed to the renderer through contextBridge as `window.acode`. */
export interface AcodeApi {
  pty: {
    create(options: PtyCreateOptions): Promise<PtyCreateResult>;
    write(id: PtyId, data: string): void;
    resize(id: PtyId, cols: number, rows: number): void;
    kill(id: PtyId): void;
    onData(listener: (event: PtyDataEvent) => void): () => void;
    onExit(listener: (event: PtyExitEvent) => void): () => void;
  };
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): void;
  };
  menu: {
    onNewTab(listener: () => void): () => void;
    onCloseTab(listener: () => void): () => void;
    onSelectTab(listener: (step: TabStep) => void): () => void;
  };
  /** Tells main that the first terminal frame of this window is on screen (startup timing). */
  firstRender(): void;
  /** Project tree, git status and file search. */
  files: FilesApi;
  /** File viewer: read, write, watch. */
  viewer: ViewerApi;
  /** IDE bridge for Claude Code: diffs, open file, selection. */
  ide: IdeApi;
  /** Terminal helpers: file links, clipboard, Claude session status. */
  terminal: TerminalApi;
  /** Read-only Claude Code configuration and usage for the project. */
  claude: ClaudeApi;
}
