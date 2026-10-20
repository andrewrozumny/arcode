/**
 * Persistent application state: recent projects, windows open at quit, per-project
 * window bounds and panel layout, and a few settings.
 *
 * Stored as JSON (normally `userData/state.json`). Writes are atomic (temp file + rename)
 * and debounced. A missing, empty or corrupt file yields the defaults. This module has no
 * Electron imports so it can be unit tested.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_LAYOUT } from '@shared/app';
import { isRecord } from '@shared/guards';
import type { PanelLayout } from '@shared/app';
import { sanitizeTerminalState } from '@shared/terminal';
import type { TerminalPaneState } from '@shared/terminal';

export const STATE_VERSION = 1;
export const MAX_RECENT = 30;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  fullScreen?: boolean;
}

export interface RecentProject {
  root: string;
  openedAt: number;
}

export interface ProjectState {
  bounds?: WindowBounds;
  layout?: PanelLayout;
  /** Terminal tabs at the last change, restored when the project opens again. */
  terminal?: TerminalPaneState;
}

export interface Settings {
  /** Path to a local SQLite project registry (table `projects`); empty disables it. */
  projectRegistryDb?: string;
}

export interface AppState {
  version: number;
  recent: RecentProject[];
  /** Project roots whose windows were open when the app last quit. */
  openWindows: string[];
  projects: Record<string, ProjectState>;
  settings: Settings;
}

export function defaultState(): AppState {
  return { version: STATE_VERSION, recent: [], openWindows: [], projects: {}, settings: {} };
}


const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function sanitizeBounds(value: unknown): WindowBounds | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height, fullScreen } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  const bounds: WindowBounds = { x, y, width, height };
  if (fullScreen === true) bounds.fullScreen = true;
  return bounds;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function sanitizeLayout(value: unknown): PanelLayout | undefined {
  if (!isRecord(value)) return undefined;
  const fraction = (raw: unknown, fallback: number): number =>
    isFiniteNumber(raw) ? clamp(raw, 0.05, 0.95) : fallback;
  return {
    treeWidth: fraction(value.treeWidth, DEFAULT_LAYOUT.treeWidth),
    terminalHeight: fraction(value.terminalHeight, DEFAULT_LAYOUT.terminalHeight),
    treeVisible: typeof value.treeVisible === 'boolean' ? value.treeVisible : DEFAULT_LAYOUT.treeVisible,
    terminalVisible:
      typeof value.terminalVisible === 'boolean' ? value.terminalVisible : DEFAULT_LAYOUT.terminalVisible,
  };
}

/** Turns whatever was on disk into a valid current-version state. */
export function migrateState(raw: unknown): AppState {
  const state = defaultState();
  if (!isRecord(raw)) return state;

  if (Array.isArray(raw.recent)) {
    for (const item of raw.recent) {
      if (isRecord(item) && typeof item.root === 'string' && item.root) {
        state.recent.push({ root: item.root, openedAt: isFiniteNumber(item.openedAt) ? item.openedAt : 0 });
      } else if (typeof item === 'string' && item) {
        state.recent.push({ root: item, openedAt: 0 });
      }
    }
    state.recent = state.recent.slice(0, MAX_RECENT);
  }
  if (Array.isArray(raw.openWindows)) {
    state.openWindows = [...new Set(raw.openWindows.filter((r): r is string => typeof r === 'string' && r !== ''))];
  }
  if (isRecord(raw.projects)) {
    for (const [root, value] of Object.entries(raw.projects)) {
      if (!isRecord(value)) continue;
      const project: ProjectState = {};
      const bounds = sanitizeBounds(value.bounds);
      const layout = sanitizeLayout(value.layout);
      if (bounds) project.bounds = bounds;
      if (layout) project.layout = layout;
      const terminal = sanitizeTerminalState(value.terminal);
      if (terminal) project.terminal = terminal;
      state.projects[root] = project;
    }
  }
  if (isRecord(raw.settings) && typeof raw.settings.projectRegistryDb === 'string') {
    state.settings.projectRegistryDb = raw.settings.projectRegistryDb;
  }
  return state;
}

export function readStateFile(path: string): AppState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return defaultState();
  }
  if (!text.trim()) return defaultState();
  try {
    return migrateState(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

export function writeStateFile(path: string, state: AppState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** In-memory state with debounced atomic persistence. */
export class StateStore {
  private state: AppState;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly path: string,
    private readonly debounceMs = 300,
  ) {
    this.state = readStateFile(path);
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  addRecent(root: string, now = Date.now()): void {
    this.state.recent = [{ root, openedAt: now }, ...this.state.recent.filter((r) => r.root !== root)].slice(
      0,
      MAX_RECENT,
    );
    this.schedule();
  }

  removeRecent(root: string): void {
    this.state.recent = this.state.recent.filter((r) => r.root !== root);
    this.schedule();
  }

  setOpenWindows(roots: string[]): void {
    this.state.openWindows = [...new Set(roots)];
    this.schedule();
  }

  project(root: string): ProjectState {
    return this.state.projects[root] ?? {};
  }

  setBounds(root: string, bounds: WindowBounds): void {
    this.state.projects[root] = { ...this.project(root), bounds };
    this.schedule();
  }

  layout(root: string): PanelLayout {
    return this.project(root).layout ?? { ...DEFAULT_LAYOUT };
  }

  setLayout(root: string, layout: unknown): void {
    const clean = sanitizeLayout(layout);
    if (!clean) return;
    this.state.projects[root] = { ...this.project(root), layout: clean };
    this.schedule();
  }

  terminal(root: string): TerminalPaneState | undefined {
    return this.project(root).terminal;
  }

  setTerminal(root: string, terminal: unknown): void {
    const clean = sanitizeTerminalState(terminal);
    if (!clean) return;
    this.state.projects[root] = { ...this.project(root), terminal: clean };
    this.schedule();
  }

  /** Writes immediately, cancelling a pending debounced write. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      writeStateFile(this.path, this.state);
    } catch (error) {
      console.error('[arcode] failed to save state', error);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }
}
