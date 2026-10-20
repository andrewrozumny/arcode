import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { enterBackgroundMode } from './background';
import { migrateLegacyUserData } from './legacy';
import { AppChannel } from '@shared/app';
import { buildMenu } from './menu';
import { ProjectSwitcher, registerProjectsIpc } from './projects';
import { isDirectory } from './registry';
import { StateStore } from './state';
import { registerWindowIpc, WindowManager } from './windows';
import { OpenRequestRouter, pathsFromArgv } from './openRequests';
import { captureScreens } from './screens';
import { registerClaudeIpc, startLiveUsage } from './claude/ipc';
import { registerFilesIpc } from './files/ipc';
import { historyDir, LocalHistory } from './viewer/history';
import { registerViewerIpc } from './viewer/ipc';
import { handlePdfProtocol, registerPdfScheme } from './viewer/pdfProtocol';
import { pasteDir, prunePastedImages } from './terminal/pasteImages';

app.setName('ARcode');
registerPdfScheme();

// One running instance: a second `open -a ARcode <path>` forwards its arguments here.
const openRequests = new OpenRequestRouter();
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    if (!openRequests.openAll(pathsFromArgv(argv, cwd))) app.focus({ steal: true });
  });
  // macOS delivers Finder / `open` paths here, possibly before `ready`; the router queues them.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    openRequests.open(path);
  });
}

void app.whenReady().then(() => {
  // A second instance is on its way out: it must not open windows, spawn shells, write IDE lock
  // files or save its stale copy of state.json over the running instance's.
  if (!isPrimary) return;
  enterBackgroundMode();
  migrateLegacyUserData(app.getPath('appData'), app.getPath('userData'));
  registerFilesIpc(ipcMain);
  const localHistory = new LocalHistory(historyDir(app.getPath('userData')));
  registerViewerIpc(ipcMain, localHistory);
  registerClaudeIpc(ipcMain);
  const liveUsage = startLiveUsage(ipcMain);
  app.on('will-quit', () => liveUsage.stop());
  const state = new StateStore(join(app.getPath('userData'), 'state.json'));
  const refreshMenu = (): void =>
    buildMenu({
      openProject: () => switcher.show(),
      openFolder: () => void switcher.openFolder(BrowserWindow.getFocusedWindow() ?? undefined),
      openRecent: (root) => switcher.open(root),
      recent: () => state.get().recent.map((r) => r.root),
      autosave: () => state.editorSettings().autosave,
      setAutosave: (on) => {
        state.setAutosave(on);
        refreshMenu();
        const settings = state.editorSettings();
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send(AppChannel.SettingsChanged, settings);
      },
    });
  const windows = new WindowManager(state, refreshMenu);
  handlePdfProtocol(() => windows.roots());
  registerWindowIpc(ipcMain, windows);
  const switcher = new ProjectSwitcher(state, windows);
  registerProjectsIpc(ipcMain, switcher, windows, state);
  refreshMenu();

  // Development override: ARCODE_CWD opens that folder directly.
  const devRoot = process.env.ARCODE_CWD;
  const startRoots = devRoot ? [devRoot] : state.get().openWindows.filter(isDirectory);
  for (const root of startRoots) windows.openProject(root);
  // Paths given on the command line (dev: `electron . <file>`) and any queued `open-file` events.
  openRequests.attach(windows);
  // Unpackaged runs carry the app folder (`.`) among the arguments, possibly after Chromium flags; skip it.
  const appPath = app.getAppPath();
  const launchPaths = pathsFromArgv(process.argv, process.cwd());
  openRequests.openAll(app.isPackaged ? launchPaths : launchPaths.filter((path) => path !== appPath));
  if (windows.count() === 0) switcher.show();

  // Dock click with no visible windows: show the project switcher.
  app.on('activate', (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) switcher.show();
  });
  app.on('before-quit', () => windows.setQuitting());
  // After every window has closed and saved its bounds.
  app.on('will-quit', () => state.flush());

  // Pasted images are only needed while the prompt that mentions them is fresh.
  void prunePastedImages(pasteDir(app.getPath('userData')));
  // Local history keeps two weeks.
  void localHistory.prune();

  if (process.env.ARCODE_SCREENS) captureScreens(process.env.ARCODE_SCREENS, windows, switcher);
});

// macOS convention: closing the last window keeps the app running.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
