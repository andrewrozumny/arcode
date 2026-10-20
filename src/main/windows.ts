/**
 * Project windows: one BrowserWindow per project root. Owns each window's pty sessions
 * and IDE bridge; terminal and IDE IPC are registered once (registerWindowIpc) and routed by sender.
 */
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { app, BrowserWindow, screen, shell } from 'electron';
import { reveal } from './background';
import type { IpcMain, Rectangle } from 'electron';
import { IpcChannel } from '@shared/ipc';
import { AppChannel, TRAFFIC_LIGHTS, baseName, isWindowAction } from '@shared/app';
import { createIdeBridge, ideEnv } from './ide';
import { guardNavigation } from './navigation';
import { IdeSession, registerIdeIpc } from './ideHost';
import { PtyManager } from './pty';
import { runSelfTest } from './selftest';
import { attachTerminalWindow, registerTerminalIpc } from './terminal/ipc';
import type { StateStore, WindowBounds } from './state';
import { contextFor, loadRenderer, PRELOAD_PATH, WINDOW_BACKGROUND } from './renderer';

export const MIN_WIDTH = 900;
export const MIN_HEIGHT = 600;

/** Header height in the renderer is 38px; traffic lights are centred in it. */

export interface ProjectWindow {
  root: string;
  win: BrowserWindow;
  ptys: PtyManager;
  /** IDE bridge for Claude Code sessions in this window's terminals. */
  ide: IdeSession;
  /** Settles once the IDE bridge is listening (or failed to start). */
  ideReady: Promise<void>;
  /** performance.now() when the window was created (startup timing). */
  openedAt: number;
}

export class WindowManager {
  private readonly byRoot = new Map<string, ProjectWindow>();
  private readonly byContents = new Map<number, ProjectWindow>();
  private quitting = false;
  private selfTestStarted = false;

  constructor(
    private readonly state: StateStore,
    private readonly onChange: () => void = () => undefined,
  ) {}

  /** Call from `before-quit`: windows closed by quitting stay in the reopen list. */
  setQuitting(): void {
    this.quitting = true;
    this.state.setOpenWindows([...this.byRoot.keys()]);
  }

  roots(): string[] {
    return [...this.byRoot.keys()];
  }

  count(): number {
    return this.byRoot.size;
  }

  /** The project window whose renderer sent an IPC message. */
  fromContents(contents: { id: number }): ProjectWindow | undefined {
    return this.byContents.get(contents.id);
  }

  /** Opens a window for the project, or focuses the existing one. */
  openProject(rawRoot: string): BrowserWindow {
    // One key per folder: a trailing slash or `..` segment must not open a second window.
    const root = resolve(rawRoot);
    const existing = this.byRoot.get(root);
    if (existing && !existing.win.isDestroyed()) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.show();
      existing.win.focus();
      return existing.win;
    }

    const openedAt = performance.now();
    const saved = this.state.project(root).bounds;
    const { x, y, width, height } = saved && isVisible(saved) ? saved : defaultBounds();
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      backgroundColor: WINDOW_BACKGROUND,
      title: baseName(root),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHTS,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Chromium's built-in PDF viewer, used by PDF tabs (arcode-pdf: frames).
        plugins: true,
      },
    });
    win.setRepresentedFilename(root);
    // Mission Control, Cmd+Tab and full screen label the window by its title: keep the project name.
    win.on('page-title-updated', (event) => event.preventDefault());

    const entry: ProjectWindow = {
      root,
      win,
      ptys: new PtyManager({
        onData: (event) => {
          if (!win.isDestroyed()) win.webContents.send(IpcChannel.PtyData, event);
        },
        onExit: (event) => {
          if (!win.isDestroyed()) win.webContents.send(IpcChannel.PtyExit, event);
        },
      }),
      ide: new IdeSession({
        root,
        target: win.webContents,
        focus: () => {
          if (win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          app.focus({ steal: true });
        },
        createBridge: (host, callbacks) => createIdeBridge(host, callbacks),
        ...(process.env.ARCODE_IDE_LOG ? { log: (message: string) => console.log(`[ide] ${message}`) } : {}),
      }),
      ideReady: Promise.resolve(),
      openedAt,
    };
    entry.ideReady = entry.ide
      .start()
      .catch((error: unknown) => console.error('[arcode] IDE bridge failed to start', error));
    attachTerminalWindow(win, entry.ptys, {
      project: baseName(root),
      notificationSound: () => this.state.notificationSound(),
    });
    const contentsId = win.webContents.id;
    this.byRoot.set(root, entry);
    this.byContents.set(contentsId, entry);

    const persistBounds = (): void => {
      if (win.isDestroyed()) return;
      const fullScreen = win.isFullScreen();
      const rect = fullScreen || win.isMaximized() ? win.getNormalBounds() : win.getBounds();
      this.state.setBounds(root, fullScreen ? { ...rect, fullScreen } : rect);
    };
    const saveBounds = debounce(persistBounds, 400);
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
    // Native traffic lights hide in full screen; the renderer draws stand-ins while it lasts.
    const reportFullScreen = (fullScreen: boolean): void => {
      saveBounds();
      if (!win.isDestroyed()) win.webContents.send(AppChannel.WindowFullScreen, fullScreen);
    };
    win.on('enter-full-screen', () => reportFullScreen(true));
    win.on('leave-full-screen', () => reportFullScreen(false));
    win.on('close', () => {
      saveBounds.cancel();
      persistBounds();
      if (!this.quitting) this.state.setOpenWindows(this.roots().filter((r) => r !== root));
    });
    win.on('closed', () => {
      entry.ptys.killAll();
      void entry.ide.stop();
      this.byRoot.delete(root);
      this.byContents.delete(contentsId);
      this.onChange();
    });

    win.once('ready-to-show', () => {
      if (saved?.fullScreen) win.setFullScreen(true);
      reveal(win);
    });
    // A reload starts a fresh renderer that knows nothing of the old ptys; end them.
    win.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) entry.ptys.killAll();
    });
    guardNavigation(win.webContents, (url) => void shell.openExternal(url));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    loadRenderer(win, contextFor('project', root));
    this.state.addRecent(root);
    this.state.setOpenWindows(this.roots());
    this.onChange();

    if (process.env.ARCODE_SELFTEST && !this.selfTestStarted) {
      this.selfTestStarted = true;
      runSelfTest(win, entry.ptys);
    }
    return win;
  }
}

/**
 * Registers the per-window channels once: terminal and IDE messages are routed to the window
 * that sent them, and the first-frame timing is logged per window.
 */
export function registerWindowIpc(ipcMain: IpcMain, windows: WindowManager): void {
  registerTerminalIpc(ipcMain, (sender) => {
    const entry = windows.fromContents(sender);
    if (!entry) return undefined;
    return {
      win: entry.win,
      ptys: entry.ptys,
      projectDir: () => entry.root,
      // Terminals point Claude Code at this window's bridge, so it connects without /ide.
      env: async () => {
        await entry.ideReady;
        return entry.ide.port ? ideEnv(entry.ide.port) : {};
      },
    };
  });
  registerIdeIpc(ipcMain, (sender) => windows.fromContents(sender)?.ide);
  ipcMain.handle(AppChannel.WindowFullScreenGet, (event) => windows.fromContents(event.sender)?.win.isFullScreen() ?? false);
  ipcMain.on(AppChannel.WindowAction, (event, action: unknown) => {
    const win = windows.fromContents(event.sender)?.win;
    if (!win || win.isDestroyed() || !isWindowAction(action)) return;
    if (action === 'close') win.close();
    else if (action === 'minimize') win.minimize();
    else win.setFullScreen(!win.isFullScreen());
  });
  let firstFrameLogged = false;
  ipcMain.on(IpcChannel.AppReady, (event) => {
    const entry = windows.fromContents(event.sender);
    if (!entry) return;
    // performance.now() in main is measured from process start.
    const sinceOpen = (performance.now() - entry.openedAt).toFixed(0);
    const sinceStart = firstFrameLogged ? '' : `, ${performance.now().toFixed(0)} ms after process start`;
    firstFrameLogged = true;
    console.log(`[arcode] first terminal frame of ${baseName(entry.root)}: ${sinceOpen} ms after window open${sinceStart}`);
  });
}

function defaultBounds(): Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

/** True when a meaningful part of the saved rectangle is on a connected display. */
function isVisible(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(a.x + a.width, bounds.x + bounds.width) - Math.max(a.x, bounds.x);
    const h = Math.min(a.y + a.height, bounds.y + bounds.height) - Math.max(a.y, bounds.y);
    return w >= 100 && h >= 50;
  });
}

interface Debounced {
  (): void;
  cancel(): void;
}

function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  }) as Debounced;
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return run;
}
