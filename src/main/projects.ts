/**
 * Project switcher: a small palette window listing recent projects, projects from the
 * optional registry and an "Open folder..." action, plus the project and layout IPC.
 */
import { BrowserWindow, dialog, screen, shell } from 'electron';
import { isBackground, reveal } from './background';
import type { IpcMain } from 'electron';
import { AppChannel } from '@shared/app';
import type { ProjectEntry, ProjectList } from '@shared/app';
import { baseName } from '@shared/app';
import { isText } from './ipcArgs';
import { guardNavigation } from './navigation';
import { expandHome, isDirectory, readRegistry } from './registry';
import type { StateStore } from './state';
import type { WindowManager } from './windows';
import { contextFor, loadRenderer, PRELOAD_PATH, WINDOW_BACKGROUND } from './renderer';
import { existingFiles } from './viewer/existing';

/**
 * Path of the local project registry database. Taken from the ARCODE_PROJECT_REGISTRY_DB
 * environment variable, else from `settings.projectRegistryDb` in state.json.
 */
export function projectRegistryDb(state: StateStore): string | undefined {
  return process.env.ARCODE_PROJECT_REGISTRY_DB || state.get().settings.projectRegistryDb || undefined;
}

const PALETTE_SIZE = { width: 640, height: 460 };

export class ProjectSwitcher {
  private palette: BrowserWindow | undefined;

  constructor(
    private readonly state: StateStore,
    private readonly windows: WindowManager,
  ) {}

  async list(): Promise<ProjectList> {
    const registry = await readRegistry(projectRegistryDb(this.state));
    const byRoot = new Map(registry.map((entry) => [entry.root, entry]));
    const recent: ProjectEntry[] = this.state
      .get()
      .recent.filter((r) => isDirectory(r.root))
      .map((r) => {
        const known = byRoot.get(r.root);
        return { ...(known ?? { name: baseName(r.root) }), root: r.root, source: 'recent', openedAt: r.openedAt };
      });
    return { recent, registry };
  }

  open(root: string): void {
    const path = expandHome(root);
    if (!isDirectory(path)) {
      this.state.removeRecent(path);
      void dialog.showMessageBox({ type: 'warning', message: `Folder not found: ${path}` });
      return;
    }
    this.hide();
    this.windows.openProject(path);
  }

  async openFolder(parent?: BrowserWindow): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: 'Open Project',
      buttonLabel: 'Open',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const root = result.canceled ? undefined : result.filePaths[0];
    if (!root) return null;
    this.open(root);
    return root;
  }

  show(): void {
    const win = this.palette && !this.palette.isDestroyed() ? this.palette : this.create();
    this.centre(win);
    if (win.webContents.isLoading()) {
      win.once('ready-to-show', () => reveal(win));
    } else {
      win.webContents.send(AppChannel.PaletteShown);
      reveal(win);
    }
    if (!isBackground) win.focus();
  }

  hide(): void {
    if (this.palette && !this.palette.isDestroyed() && this.palette.isVisible()) this.palette.hide();
  }

  paletteWindow(): BrowserWindow | undefined {
    return this.palette && !this.palette.isDestroyed() ? this.palette : undefined;
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      ...PALETTE_SIZE,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: WINDOW_BACKGROUND,
      title: 'Open Project',
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Dismiss on click-away, but only when a project window exists to fall back to.
    win.on('blur', () => {
      if (this.windows.count() > 0) this.hide();
    });
    win.on('closed', () => {
      this.palette = undefined;
    });
    guardNavigation(win.webContents, (url) => void shell.openExternal(url));
    loadRenderer(win, contextFor('palette'));
    this.palette = win;
    return win;
  }

  /** Centres the palette on the display under the focused window or the cursor. */
  private centre(win: BrowserWindow): void {
    const focused = BrowserWindow.getFocusedWindow();
    const display =
      focused && focused !== win
        ? screen.getDisplayMatching(focused.getBounds())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    win.setBounds({
      ...PALETTE_SIZE,
      x: Math.round(area.x + (area.width - PALETTE_SIZE.width) / 2),
      y: Math.round(area.y + area.height * 0.18),
    });
  }
}

/** Registers the project switcher, layout, saved terminal and viewer tabs, recent files and settings channels. */
export function registerProjectsIpc(ipcMain: IpcMain, switcher: ProjectSwitcher, windows: WindowManager, state: StateStore): void {
  ipcMain.handle(AppChannel.ProjectsList, () => switcher.list());
  ipcMain.on(AppChannel.ProjectsOpen, (_event, root: unknown) => {
    if (isText(root) && root) switcher.open(root);
  });
  ipcMain.handle(AppChannel.ProjectsOpenFolder, async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    // The palette hides on blur; parent the dialog to a project window instead.
    const parent = sender && sender !== switcher.paletteWindow() ? sender : undefined;
    if (!parent) switcher.hide();
    const root = await switcher.openFolder(parent);
    if (!root && !parent && windows.count() === 0) switcher.show();
    return root;
  });
  ipcMain.on(AppChannel.PaletteShow, () => switcher.show());
  ipcMain.on(AppChannel.PaletteHide, () => switcher.hide());
  ipcMain.handle(AppChannel.LayoutGet, (_event, root: unknown) => (isText(root) ? state.layout(root) : null));
  ipcMain.on(AppChannel.LayoutSet, (_event, root: unknown, layout: unknown) => {
    if (isText(root) && root) state.setLayout(root, layout);
  });
  ipcMain.handle(AppChannel.TerminalStateGet, (_event, root: unknown) =>
    isText(root) ? (state.terminal(root) ?? null) : null,
  );
  ipcMain.on(AppChannel.TerminalStateSet, (_event, root: unknown, terminal: unknown) => {
    if (isText(root) && root) state.setTerminal(root, terminal);
  });
  ipcMain.handle(AppChannel.ViewerTabsGet, async (_event, root: unknown) => {
    const saved = isText(root) && root ? state.viewerTabs(root) : undefined;
    if (!isText(root) || !saved) return null;
    const files = await existingFiles(root, saved.files);
    return { files, active: saved.active !== null && files.includes(saved.active) ? saved.active : null };
  });
  ipcMain.on(AppChannel.ViewerTabsSet, (_event, root: unknown, tabs: unknown) => {
    if (isText(root) && root) state.setViewerTabs(root, tabs);
  });
  ipcMain.handle(AppChannel.RecentFilesGet, (_event, root: unknown) =>
    isText(root) && root ? existingFiles(root, state.recentFiles(root)) : [],
  );
  ipcMain.on(AppChannel.RecentFilesAdd, (_event, root: unknown, path: unknown) => {
    if (isText(root) && root && isText(path)) state.addRecentFile(root, path);
  });
  ipcMain.handle(AppChannel.SettingsGet, () => state.editorSettings());
}
