import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { AcodeApi, PtyDataEvent, PtyExitEvent, TabStep } from '@shared/ipc';
import { AppChannel, parseWindowContext } from '@shared/app';
import type { AcodeAppApi, LayoutCommand } from '@shared/app';
import type { EditorSettings } from '@shared/editorState';
import { claudeApi } from './claude';
import { subscribe } from './subscribe';
import { filesApi } from './files';
import { ideApi } from './ide';
import { terminalApi } from './terminal';
import { viewerApi } from './viewer';

// The preload is type-checked without DOM types; the page URL carries the window context.
const pageLocation = (globalThis as unknown as { location: { search: string } }).location;
const windowContext = parseWindowContext(pageLocation.search);

const appApi: AcodeAppApi = {
  app: {
    context: () => ({ ...windowContext }),
    showPalette: () => ipcRenderer.send(AppChannel.PaletteShow),
    hidePalette: () => ipcRenderer.send(AppChannel.PaletteHide),
    onPaletteShown: (listener) => subscribe<[]>(AppChannel.PaletteShown, listener),
    onLayoutCommand: (listener) => subscribe<[LayoutCommand]>(AppChannel.MenuLayout, listener),
  },
  window: {
    isFullScreen: () => ipcRenderer.invoke(AppChannel.WindowFullScreenGet),
    onFullScreen: (listener) => subscribe<[boolean]>(AppChannel.WindowFullScreen, listener),
    action: (action) => ipcRenderer.send(AppChannel.WindowAction, action),
  },
  projects: {
    list: () => ipcRenderer.invoke(AppChannel.ProjectsList),
    open: (root) => ipcRenderer.send(AppChannel.ProjectsOpen, root),
    openFolder: () => ipcRenderer.invoke(AppChannel.ProjectsOpenFolder),
  },
  layout: {
    get: (root) => ipcRenderer.invoke(AppChannel.LayoutGet, root),
    set: (root, layout) => ipcRenderer.send(AppChannel.LayoutSet, root, layout),
    getTerminal: (root) => ipcRenderer.invoke(AppChannel.TerminalStateGet, root),
    setTerminal: (root, state) => ipcRenderer.send(AppChannel.TerminalStateSet, root, state),
    getViewerTabs: (root) => ipcRenderer.invoke(AppChannel.ViewerTabsGet, root),
    setViewerTabs: (root, state) => ipcRenderer.send(AppChannel.ViewerTabsSet, root, state),
    getRecentFiles: (root) => ipcRenderer.invoke(AppChannel.RecentFilesGet, root),
    addRecentFile: (root, path) => ipcRenderer.send(AppChannel.RecentFilesAdd, root, path),
  },
  settings: {
    get: () => ipcRenderer.invoke(AppChannel.SettingsGet),
    onChange: (listener) => subscribe<[EditorSettings]>(AppChannel.SettingsChanged, listener),
  },
};

const api: AcodeApi & AcodeAppApi = {
  ...appApi,
  pty: {
    create: (options) => ipcRenderer.invoke(IpcChannel.PtyCreate, options),
    write: (id, data) => ipcRenderer.send(IpcChannel.PtyWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IpcChannel.PtyResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(IpcChannel.PtyKill, id),
    onData: (listener) => subscribe<[PtyDataEvent]>(IpcChannel.PtyData, listener),
    onExit: (listener) => subscribe<[PtyExitEvent]>(IpcChannel.PtyExit, listener),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(IpcChannel.ClipboardRead),
    writeText: (text) => ipcRenderer.send(IpcChannel.ClipboardWrite, text),
  },
  menu: {
    onNewTab: (listener) => subscribe<[]>(IpcChannel.MenuNewTab, listener),
    onCloseTab: (listener) => subscribe<[]>(IpcChannel.MenuCloseTab, listener),
    onSelectTab: (listener) => subscribe<[TabStep]>(IpcChannel.MenuSelectTab, listener),
    onJumpWaiting: (listener) => subscribe<[]>(IpcChannel.MenuJumpWaiting, listener),
  },
  firstRender: () => ipcRenderer.send(IpcChannel.AppReady),
  files: filesApi,
  viewer: viewerApi,
  ide: ideApi,
  terminal: terminalApi,
  claude: claudeApi,
};

contextBridge.exposeInMainWorld('acode', api);
