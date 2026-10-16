/** IPC contract of the file viewer. No Electron imports: shared by main, preload and renderer. */

export const ViewerChannel = {
  ReadFile: 'viewer:read-file',
  WriteFile: 'viewer:write-file',
  HeadContent: 'viewer:head-content',
  WatchFile: 'viewer:watch-file',
  UnwatchFile: 'viewer:unwatch-file',
  FileChanged: 'viewer:fileChanged',
  OpenDefault: 'viewer:open-default',
  Reveal: 'viewer:reveal',
} as const;

export type ReadFileResult =
  | { kind: 'text'; content: string; encoding: 'utf-8'; size: number; mtime: number }
  | {
      kind: 'image';
      dataUrl: string;
      mime: string;
      size: number;
      mtime: number;
      /** Present for SVG only, so the viewer can switch to source. */
      svgSource?: string;
    }
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'error'; message: string };

export type WriteFileResult =
  | { ok: true; mtime: number }
  /** The file changed on disk after it was read (or appeared/disappeared). */
  | { ok: false; reason: 'conflict'; mtime: number | null }
  | { ok: false; reason: 'error'; message: string };

export interface FileChangedEvent {
  root: string;
  relPath: string;
  /** New modification time, or null when the file was removed. */
  mtime: number | null;
}

export interface ViewerApi {
  readFile(root: string, relPath: string): Promise<ReadFileResult>;
  /** `expectedMtime` is the mtime from the last read; null means "the file must not exist yet". */
  writeFile(
    root: string,
    relPath: string,
    content: string,
    expectedMtime: number | null,
  ): Promise<WriteFileResult>;
  /** Content of the file at git HEAD, or null when it is not in HEAD / not a git repo. */
  headContent(root: string, relPath: string): Promise<string | null>;
  watchFile(root: string, relPath: string): Promise<void>;
  unwatchFile(root: string, relPath: string): Promise<void>;
  onFileChanged(listener: (event: FileChangedEvent) => void): () => void;
  openDefault(root: string, relPath: string): Promise<void>;
  reveal(root: string, relPath: string): Promise<void>;
}

/** Limits shared between main and UI. */
export const TEXT_SIZE_LIMIT = 5 * 1024 * 1024;
export const IMAGE_SIZE_LIMIT = 30 * 1024 * 1024;
