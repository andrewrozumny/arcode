/**
 * Channels and types for windows, projects and layout. Shared by main, preload and renderer.
 * Terminal channels live in ./ipc.ts.
 */
import type { EditorSettings, ViewerTabsState } from './editorState';
import type { TerminalPaneState } from './terminal';

export const AppChannel = {
  /** renderer -> main (invoke): saved layout for a project root. */
  LayoutGet: 'app:layout-get',
  /** renderer -> main (send): persist layout for a project root. */
  LayoutSet: 'app:layout-set',
  /** main -> renderer: a layout command from the menu. */
  MenuLayout: 'menu:layout',
  /** renderer -> main (invoke): saved terminal tabs for a project root. */
  TerminalStateGet: 'app:terminal-state-get',
  /** renderer -> main (send): persist terminal tabs for a project root. */
  TerminalStateSet: 'app:terminal-state-set',
  /** renderer -> main (invoke): saved viewer file tabs for a project root (missing files dropped). */
  ViewerTabsGet: 'app:viewer-tabs-get',
  /** renderer -> main (send): persist viewer file tabs for a project root. */
  ViewerTabsSet: 'app:viewer-tabs-set',
  /** renderer -> main (invoke): recently opened files of a project root that still exist. */
  RecentFilesGet: 'app:recent-files-get',
  /** renderer -> main (send): a file of a project root was opened or brought to front. */
  RecentFilesAdd: 'app:recent-files-add',
  /** renderer -> main (invoke): editor settings. */
  SettingsGet: 'app:settings-get',
  /** main -> renderer: editor settings changed (menu toggle). */
  SettingsChanged: 'app:settings-changed',
  /** renderer -> main (invoke): recent projects and registry projects. */
  ProjectsList: 'projects:list',
  /** renderer -> main (send): open (or focus) a project window. */
  ProjectsOpen: 'projects:open',
  /** renderer -> main (invoke): native folder picker, opens the chosen folder. */
  ProjectsOpenFolder: 'projects:open-folder',
  /** renderer -> main (send): show the project switcher. */
  PaletteShow: 'palette:show',
  /** renderer -> main (send): hide the project switcher. */
  PaletteHide: 'palette:hide',
  /** main -> palette renderer: the switcher was shown again, refresh and reset. */
  PaletteShown: 'palette:shown',
  /** renderer -> main (invoke): whether this window is in full screen. */
  WindowFullScreenGet: 'window:full-screen-get',
  /** main -> renderer: the window entered (true) or left (false) full screen. */
  WindowFullScreen: 'window:full-screen',
  /** renderer -> main (send): close, minimize or toggle full screen for the sender's window. */
  WindowAction: 'window:action',
} as const;

/** Native traffic light position of project windows; the full-screen stand-ins line up with it. */
export const TRAFFIC_LIGHTS = { x: 14, y: 12 } as const;

export type WindowAction = 'close' | 'minimize' | 'toggle-full-screen';

const WINDOW_ACTIONS: readonly WindowAction[] = ['close', 'minimize', 'toggle-full-screen'];

export function isWindowAction(value: unknown): value is WindowAction {
  return WINDOW_ACTIONS.includes(value as WindowAction);
}

export type LayoutCommand = 'toggle-tree' | 'toggle-terminal' | 'hide-panels';

/** Targets of `scripts/gates.sh`, in display order. */
export type GateTarget = 'all' | 'lint' | 'test' | 'build' | 'deploy';

export const GATE_TARGETS: readonly GateTarget[] = ['all', 'lint', 'test', 'build', 'deploy'];

/** Button labels of the gate targets in the header and the terminal's Gate menu. */
export const GATE_LABELS: Record<GateTarget, string> = {
  all: 'ALL',
  lint: 'lint',
  test: 'test',
  build: 'build',
  deploy: 'deploy',
};

/** Per-project panel layout. Sizes are fractions so they survive window resizes. */
export interface PanelLayout {
  /** Tree width as a fraction of the window width. */
  treeWidth: number;
  /** Terminal dock height as a fraction of the right column height. */
  terminalHeight: number;
  treeVisible: boolean;
  terminalVisible: boolean;
}

export const DEFAULT_LAYOUT: PanelLayout = {
  treeWidth: 0.29,
  terminalHeight: 0.39,
  treeVisible: true,
  terminalVisible: true,
};

export type ProjectSource = 'recent' | 'registry';

export interface ProjectEntry {
  /** Absolute path of the project folder. */
  root: string;
  name: string;
  source: ProjectSource;
  slug?: string;
  status?: string;
  kind?: string;
  /** Epoch ms, recent projects only. */
  openedAt?: number;
}

export interface ProjectList {
  recent: ProjectEntry[];
  registry: ProjectEntry[];
}

/** What kind of page a renderer window shows, passed in the page URL query. */
export type WindowView = 'project' | 'palette';

export interface WindowContext {
  view: WindowView;
  /** Absolute project root, empty for the palette. */
  projectRoot: string;
  /** User home directory, used to shorten paths for display. */
  home: string;
}

export function windowQuery(context: WindowContext): Record<string, string> {
  return { view: context.view, root: context.projectRoot, home: context.home };
}

export function parseWindowContext(search: string): WindowContext {
  const params = new URLSearchParams(search);
  return {
    view: params.get('view') === 'palette' ? 'palette' : 'project',
    projectRoot: params.get('root') ?? '',
    home: params.get('home') ?? '',
  };
}

/** "/Users/me/startup/app" -> "~/startup/app". */
export function shortenPath(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

/** Window, project and layout API exposed as `window.acode.app` / `projects` / `layout`. */
export interface AcodeAppApi {
  app: {
    /** Context of this window, parsed from the page URL. */
    context(): WindowContext;
    showPalette(): void;
    hidePalette(): void;
    onPaletteShown(listener: () => void): () => void;
    onLayoutCommand(listener: (command: LayoutCommand) => void): () => void;
  };
  window: {
    isFullScreen(): Promise<boolean>;
    onFullScreen(listener: (fullScreen: boolean) => void): () => void;
    action(action: WindowAction): void;
  };
  projects: {
    list(): Promise<ProjectList>;
    open(root: string): void;
    openFolder(): Promise<string | null>;
  };
  layout: {
    get(root: string): Promise<PanelLayout>;
    set(root: string, layout: PanelLayout): void;
    /** Saved terminal tabs of the project, null when there are none. */
    getTerminal(root: string): Promise<TerminalPaneState | null>;
    setTerminal(root: string, state: TerminalPaneState): void;
    /** Saved viewer file tabs of the project (files that no longer exist dropped), null when none. */
    getViewerTabs(root: string): Promise<ViewerTabsState | null>;
    setViewerTabs(root: string, state: ViewerTabsState): void;
    /** Recently opened files (project-relative, most recent first) that still exist. */
    getRecentFiles(root: string): Promise<string[]>;
    addRecentFile(root: string, path: string): void;
  };
  settings: {
    get(): Promise<EditorSettings>;
    onChange(listener: (settings: EditorSettings) => void): () => void;
  };
}
