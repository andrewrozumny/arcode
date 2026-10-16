import { ipcRenderer, webUtils } from 'electron';
import { FilesChannel } from '@shared/files';
import type { FilesApi, FilesChangedEvent, FilesGitStatusEvent } from '@shared/files';
import { subscribe } from './subscribe';

/** Exposed as `window.acode.files` from the preload entry. */
export const filesApi: FilesApi = {
  listDir: (root, relDir) => ipcRenderer.invoke(FilesChannel.ListDir, root, relDir),
  gitStatus: (root) => ipcRenderer.invoke(FilesChannel.GitStatus, root),
  branch: (root) => ipcRenderer.invoke(FilesChannel.Branch, root),
  search: (root, query, limit) => ipcRenderer.invoke(FilesChannel.Search, root, query, limit),
  watch: (root) => ipcRenderer.invoke(FilesChannel.Watch, root),
  unwatch: (root) => ipcRenderer.invoke(FilesChannel.Unwatch, root),
  reveal: (root, relPath) => ipcRenderer.invoke(FilesChannel.Reveal, root, relPath),
  op: (root, op) => ipcRenderer.invoke(FilesChannel.Op, root, op),
  externalPlaces: () => ipcRenderer.invoke(FilesChannel.ExternalPlaces),
  externalList: (path) => ipcRenderer.invoke(FilesChannel.ExternalList, path),
  externalPreview: (path) => ipcRenderer.invoke(FilesChannel.ExternalPreview, path),
  importFiles: (root, relDir, sources) => ipcRenderer.invoke(FilesChannel.Import, root, relDir, sources),
  clipboardFiles: () => ipcRenderer.invoke(FilesChannel.ClipboardFiles),
  copyToClipboard: (paths) => ipcRenderer.invoke(FilesChannel.CopyToClipboard, paths),
  // Dropped File objects carry no path in the renderer; only the preload can map them.
  pathForFile: (file) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  onChanged: (listener) => subscribe<[FilesChangedEvent]>(FilesChannel.Changed, listener),
  onGitStatus: (listener) => subscribe<[FilesGitStatusEvent]>(FilesChannel.GitStatusEvent, listener),
};
