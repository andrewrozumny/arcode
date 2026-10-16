import { ipcRenderer } from 'electron';
import { IdeChannel } from '@shared/ide-ipc';
import type {
  IdeApi,
  IdeCloseTabMessage,
  IdeOpenDiffMessage,
  IdeOpenFileMessage,
  IdeStatus,
} from '@shared/ide-ipc';
import { subscribe } from './subscribe';

/** Exposed as `window.acode.ide` from the preload entry. */
export const ideApi: IdeApi = {
  getStatus: () => ipcRenderer.invoke(IdeChannel.GetStatus),
  onStatus: (listener) => subscribe<[IdeStatus]>(IdeChannel.Status, listener),
  onOpenDiff: (listener) => subscribe<[IdeOpenDiffMessage]>(IdeChannel.OpenDiff, listener),
  sendOpenDiffResult: (message) => ipcRenderer.send(IdeChannel.OpenDiffResult, message),
  onOpenFile: (listener) => subscribe<[IdeOpenFileMessage]>(IdeChannel.OpenFile, listener),
  onCloseTab: (listener) => subscribe<[IdeCloseTabMessage]>(IdeChannel.CloseTab, listener),
  onCloseAllDiffTabs: (listener) => subscribe<[]>(IdeChannel.CloseAllDiffTabs, () => listener()),
  selectionChanged: (message) => ipcRenderer.send(IdeChannel.SelectionChanged, message),
  atMentioned: (message) => ipcRenderer.send(IdeChannel.AtMentioned, message),
};
