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
  ListSnapshots: 'viewer:list-snapshots',
  ReadSnapshot: 'viewer:read-snapshot',
  RestoreSnapshot: 'viewer:restore-snapshot',
} as const;

/** Why a local history snapshot was taken: before ARcode saved, or when the file changed from outside. */
export type SnapshotSource = 'save' | 'external';

export interface SnapshotInfo {
  /** File name of the snapshot inside the file's history folder. */
  id: string;
  /** When it was taken, ms since the epoch. */
  timestamp: number;
  size: number;
  source: SnapshotSource;
}

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
  | {
      kind: 'pdf';
      /** `arcode-pdf:` URL the viewer's iframe loads; changes with the file's mtime. */
      url: string;
      size: number;
      mtime: number;
      /** Project-relative path of `foo.md` next to `foo.pdf`, when it exists. */
      markdownSource: string | null;
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
  /** Local history of a file, newest first. */
  listSnapshots(root: string, relPath: string): Promise<SnapshotInfo[]>;
  /** Content of one snapshot, or null when it is gone. */
  readSnapshot(root: string, relPath: string, id: string): Promise<string | null>;
  /**
   * Writes a snapshot back through the guarded write (same mtime check as `writeFile`). The content
   * on disk right before is kept as a new snapshot.
   */
  restoreSnapshot(root: string, relPath: string, id: string, expectedMtime: number | null): Promise<WriteFileResult>;
}

/** Limits shared between main and UI. */
export const TEXT_SIZE_LIMIT = 5 * 1024 * 1024;
export const IMAGE_SIZE_LIMIT = 30 * 1024 * 1024;
