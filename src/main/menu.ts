/** Application menu. Rebuilt when the recent projects list changes. */
import { app, BrowserWindow, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { TabStep } from '@shared/ipc';
import { AppChannel, shortenPath } from '@shared/app';
import type { LayoutCommand } from '@shared/app';
import os from 'node:os';

export interface MenuActions {
  openProject(): void;
  openFolder(): void;
  openRecent(root: string): void;
  recent(): string[];
  /** Current value of the Autosave setting and its toggle. */
  autosave(): boolean;
  setAutosave(on: boolean): void;
  /** Current value of the Notification Sound setting and its toggle. */
  notificationSound(): boolean;
  setNotificationSound(on: boolean): void;
}

const RECENT_IN_MENU = 15;

export function buildMenu(actions: MenuActions): void {
  const send =
    (channel: string, ...args: unknown[]) =>
    (): void =>
      BrowserWindow.getFocusedWindow()?.webContents.send(channel, ...args);
  const layout = (command: LayoutCommand) => send(AppChannel.MenuLayout, command);
  const step = (value: TabStep) => send(IpcChannel.MenuSelectTab, value);
  const dev = !app.isPackaged;
  const home = os.homedir();

  const recent = actions.recent().slice(0, RECENT_IN_MENU);
  const recentItems: MenuItemConstructorOptions[] = recent.length
    ? recent.map((root) => ({ label: shortenPath(root, home), click: () => actions.openRecent(root) }))
    : [{ label: 'No Recent Projects', enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Open Project...', accelerator: 'CmdOrCtrl+Shift+O', click: actions.openProject },
        { label: 'Open Folder...', click: actions.openFolder },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        {
          label: 'Autosave',
          type: 'checkbox',
          checked: actions.autosave(),
          click: (item) => actions.setAutosave(item.checked),
        },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
      ],
    },
    {
      // Copy/paste roles are required for text fields. The terminal handles Cmd+C/V
      // itself and prevents the default, so these roles never reach it.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Project Tree', accelerator: 'CmdOrCtrl+1', click: layout('toggle-tree') },
        { label: 'Terminal', accelerator: 'CmdOrCtrl+2', click: layout('toggle-terminal') },
        { label: 'Hide All Panels', accelerator: 'CmdOrCtrl+Shift+F12', click: layout('hide-panels') },
        { type: 'separator' },
        ...(dev
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send(IpcChannel.MenuNewTab) },
        // The renderer decides by focus: terminal tab or viewer tab.
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send(IpcChannel.MenuCloseTab) },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: step(1) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: step(-1) },
        { type: 'separator' },
        // Like Jump to Waiting, the page handles the key (shortcuts.ts); the item is for clicks and discovery.
        { label: 'Split Right', accelerator: 'CmdOrCtrl+\\', click: send(IpcChannel.MenuSplitTerminal) },
        { type: 'separator' },
        // The page handles the key itself (shortcuts.ts); the item is for clicks and discovery.
        { label: 'Jump to Waiting Claude Tab', accelerator: 'CmdOrCtrl+Shift+J', click: send(IpcChannel.MenuJumpWaiting) },
        {
          label: 'Notification Sound',
          type: 'checkbox',
          checked: actions.notificationSound(),
          click: (item) => actions.setNotificationSound(item.checked),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
