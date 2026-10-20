import { ipcRenderer, webUtils } from 'electron';
import { TerminalChannel } from '@shared/terminal';
import type { PtyId } from '@shared/ipc';
import type { ClaudeStatusEvent, TerminalApi } from '@shared/terminal';
import { subscribe } from './subscribe';

/** Exposed as `window.acode.terminal` from the preload entry. */
export const terminalApi: TerminalApi = {
  resolveFile: (path, projectRoot) => ipcRenderer.invoke(TerminalChannel.ResolveFile, path, projectRoot),
  clipboardInfo: () => ipcRenderer.invoke(TerminalChannel.ClipboardInfo),
  savePastedImage: (bytes, mimeType) => ipcRenderer.invoke(TerminalChannel.SavePastedImage, bytes, mimeType),
  hasChildren: (ptyId) => ipcRenderer.invoke(TerminalChannel.HasChildren, ptyId),
  sessionExists: (sessionId) => ipcRenderer.invoke(TerminalChannel.SessionExists, sessionId),
  claudeSnapshot: () => ipcRenderer.invoke(TerminalChannel.ClaudeSnapshot),
  onClaudeStatus: (listener) => subscribe<[ClaudeStatusEvent]>(TerminalChannel.ClaudeStatus, listener),
  attention: (request) => ipcRenderer.send(TerminalChannel.Attention, request),
  tabTitles: (titles) => ipcRenderer.send(TerminalChannel.TabTitles, titles),
  onFocusPty: (listener) => subscribe<[PtyId]>(TerminalChannel.FocusPty, listener),
  pathForFile: (file) => webUtils.getPathForFile(file),
};
