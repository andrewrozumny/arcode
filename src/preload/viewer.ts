import { ipcRenderer } from 'electron';
import { ViewerChannel } from '@shared/viewer';
import type { FileChangedEvent, ViewerApi } from '@shared/viewer';
import { subscribe } from './subscribe';

/** Exposed as `window.acode.viewer` from the preload entry. */
export const viewerApi: ViewerApi = {
  readFile: (root, relPath) => ipcRenderer.invoke(ViewerChannel.ReadFile, root, relPath),
  writeFile: (root, relPath, content, expectedMtime) =>
    ipcRenderer.invoke(ViewerChannel.WriteFile, root, relPath, content, expectedMtime),
  headContent: (root, relPath) => ipcRenderer.invoke(ViewerChannel.HeadContent, root, relPath),
  watchFile: (root, relPath) => ipcRenderer.invoke(ViewerChannel.WatchFile, root, relPath),
  unwatchFile: (root, relPath) => ipcRenderer.invoke(ViewerChannel.UnwatchFile, root, relPath),
  onFileChanged: (listener) => subscribe<[FileChangedEvent]>(ViewerChannel.FileChanged, listener),
  openDefault: (root, relPath) => ipcRenderer.invoke(ViewerChannel.OpenDefault, root, relPath),
  reveal: (root, relPath) => ipcRenderer.invoke(ViewerChannel.Reveal, root, relPath),
  listSnapshots: (root, relPath) => ipcRenderer.invoke(ViewerChannel.ListSnapshots, root, relPath),
  readSnapshot: (root, relPath, id) => ipcRenderer.invoke(ViewerChannel.ReadSnapshot, root, relPath, id),
  restoreSnapshot: (root, relPath, id, expectedMtime) =>
    ipcRenderer.invoke(ViewerChannel.RestoreSnapshot, root, relPath, id, expectedMtime),
};
