/** Types shared between the IDE bridge (main process) and the UI host. No Electron imports. */

export interface OpenDiffRequest {
  oldFilePath: string
  newFilePath: string
  newFileContents: string
  tabName: string
}

export type OpenDiffResult =
  | { result: 'saved'; contents: string }
  | { result: 'rejected' }
  | { result: 'closed' }

export interface OpenFileRequest {
  filePath: string
  makeFrontmost: boolean
}

/** Implemented by the UI layer; the bridge calls it when the CLI invokes IDE tools. */
export interface IdeHost {
  /** Must resolve only when the user decides. No timeout. */
  openDiff(req: OpenDiffRequest): Promise<OpenDiffResult>
  closeTab(tabName: string): void | Promise<void>
  closeAllDiffTabs(): void | Promise<void>
  openFile(req: OpenFileRequest): void | Promise<void>
}

export interface Position {
  line: number
  character: number
}

/** All positions are zero-based. */
export interface SelectionChangedPayload {
  selection: { start: Position; end: Position } | null
  text: string | null
  filePath: string
}

export interface AtMentionedPayload {
  filePath: string
  lineStart?: number
  lineEnd?: number
}

export interface IdeBridgeStartOptions {
  workspaceFolders: string[]
  ideName?: string
  pid?: number
}
