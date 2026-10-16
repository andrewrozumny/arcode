/**
 * IPC between the per-window IDE bridge (main) and the viewer (renderer). No Electron imports.
 *
 * main -> renderer: OpenDiff, OpenFile, CloseTab, CloseAllDiffTabs, Status.
 * renderer -> main: OpenDiffResult, SelectionChanged, AtMentioned, GetStatus (invoke).
 */
import type { OpenDiffResult, Position } from './ide';

export const IdeChannel = {
  /** main -> renderer: show a diff tab; answer with OpenDiffResult and the same requestId. */
  OpenDiff: 'ide:openDiff',
  /** renderer -> main: the user's decision for an OpenDiff request. */
  OpenDiffResult: 'ide:openDiffResult',
  OpenFile: 'ide:openFile',
  CloseTab: 'ide:closeTab',
  CloseAllDiffTabs: 'ide:closeAllDiffTabs',
  /** renderer -> main: active file or selection changed in the viewer. */
  SelectionChanged: 'ide:selectionChanged',
  /** renderer -> main: mention the current file/selection in the connected CLI. */
  AtMentioned: 'ide:atMentioned',
  /** main -> renderer: bridge port and connected client count. */
  Status: 'ide:status',
  /** renderer -> main (invoke): current IdeStatus. */
  GetStatus: 'ide:getStatus',
} as const;

export interface IdeOpenDiffMessage {
  requestId: number;
  tabName: string;
  /** Absolute paths. */
  oldPath: string;
  newPath: string;
  /** Current file contents on disk; empty for a file that does not exist yet. */
  oldContent: string;
  newContent: string;
}

export interface IdeOpenDiffResultMessage {
  requestId: number;
  result: OpenDiffResult;
}

export interface IdeOpenFileMessage {
  /** Absolute path. */
  filePath: string;
  /** 1-based line to reveal, when known. */
  line?: number;
}

export interface IdeCloseTabMessage {
  tabName: string;
}

/** What the viewer reports; positions are zero-based. */
export interface IdeSelectionMessage {
  /** Absolute path of the active file. */
  filePath: string;
  selection: { start: Position; end: Position };
  /** Selected text, or null for an empty selection. */
  text: string | null;
}

export interface IdeAtMentionMessage {
  /** Absolute path. */
  filePath: string;
  /** Zero-based, inclusive. Omitted to mention the whole file. */
  lineStart?: number;
  lineEnd?: number;
}

export interface IdeStatus {
  /** Port of the bridge, 0 while it is not running. */
  port: number;
  /** Connected CLI clients. */
  clients: number;
}

/** Exposed to the renderer as `window.acode.ide`. */
export interface IdeApi {
  getStatus(): Promise<IdeStatus>;
  onStatus(listener: (status: IdeStatus) => void): () => void;
  onOpenDiff(listener: (message: IdeOpenDiffMessage) => void): () => void;
  sendOpenDiffResult(message: IdeOpenDiffResultMessage): void;
  onOpenFile(listener: (message: IdeOpenFileMessage) => void): () => void;
  onCloseTab(listener: (message: IdeCloseTabMessage) => void): () => void;
  onCloseAllDiffTabs(listener: () => void): () => void;
  selectionChanged(message: IdeSelectionMessage | null): void;
  atMentioned(message: IdeAtMentionMessage): void;
}

/** Wire payload of `selection_changed` (the shape IDE extensions send). */
export interface IdeSelectionWirePayload {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: { start: Position; end: Position; isEmpty: boolean };
}

export function toSelectionWirePayload(message: IdeSelectionMessage): IdeSelectionWirePayload {
  const { start, end } = message.selection;
  return {
    text: message.text ?? '',
    filePath: message.filePath,
    fileUrl: `file://${message.filePath}`,
    selection: {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
      isEmpty: start.line === end.line && start.character === end.character,
    },
  };
}
