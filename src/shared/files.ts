/** IPC channels and payload types for the file tree, git status and file search. No Electron imports. */

export const FilesChannel = {
  ListDir: 'files:listDir',
  GitStatus: 'files:gitStatus',
  /** Current branch name (or short sha on a detached HEAD); null outside a repository. */
  Branch: 'files:branch',
  Search: 'files:search',
  Watch: 'files:watch',
  Unwatch: 'files:unwatch',
  Reveal: 'files:reveal',
  Op: 'files:op',
  /** Event: paths changed on disk. */
  Changed: 'files:changed',
  /** Event: git status was recomputed. */
  GitStatusEvent: 'files:gitStatusEvent',
  /** Quick places of the import dialog (Downloads, Recent, Screenshots). */
  ExternalPlaces: 'files:externalPlaces',
  /** Entries of a folder outside the project, or of the Recent place. */
  ExternalList: 'files:externalList',
  /** Copies files from outside the project into a project folder. */
  Import: 'files:import',
  /** Absolute paths of files copied in Finder (empty when the clipboard holds no files). */
  ClipboardFiles: 'files:clipboardFiles',
  CopyToClipboard: 'files:copyToClipboard',
  ExternalPreview: 'files:externalPreview',
} as const;

/**
 * DataTransfer type carrying absolute paths when tree rows are dragged inside the app. The value is a
 * JSON array of strings (see `encodeDraggedPaths`), so a file name with a newline stays one path.
 */
export const ACODE_PATH_TYPE = 'application/x-acode-path';

/** The ACODE_PATH_TYPE value for `paths`. */
export function encodeDraggedPaths(paths: readonly string[]): string {
  return JSON.stringify(paths);
}

/** Paths from an ACODE_PATH_TYPE value; anything that is not a JSON array of strings counts as one path. */
export function decodeDraggedPaths(value: string): string[] {
  if (value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [value];
  }
  if (!Array.isArray(parsed) || !parsed.every((p): p is string => typeof p === 'string')) return [value];
  return parsed.filter((p) => p.length > 0);
}

export type EntryKind = 'file' | 'dir' | 'symlink';

export interface DirEntry {
  name: string;
  kind: EntryKind;
  /** Matches .gitignore rules. */
  ignored: boolean;
  /** Known-huge folder (node_modules, .git, ...): shown grey, expanded only on explicit request. */
  heavy: boolean;
}

/** M modified, A added, D deleted, ? untracked, R renamed, C copied, U conflicted. */
export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'R' | 'C' | 'U';

export interface GitBranch {
  /** Branch name, or the short commit sha when HEAD is detached. */
  name: string;
  detached: boolean;
}

export interface GitStatusMap {
  /** Project-relative file path (forward slashes) to status. */
  files: Record<string, GitStatusCode>;
  /** Project-relative folders that contain at least one changed file. */
  dirs: string[];
}

export interface SearchRange {
  start: number;
  end: number;
}

export interface SearchResult {
  /** Project-relative path. */
  path: string;
  score: number;
  /** Matched character ranges in `path` (end exclusive). */
  ranges: SearchRange[];
}

export type FileOp =
  | { type: 'createFile'; relPath: string }
  | { type: 'createDir'; relPath: string }
  | { type: 'rename'; relPath: string; newRelPath: string }
  | { type: 'delete'; relPath: string };

export interface FilesChangedEvent {
  root: string;
  /** Project-relative paths. */
  paths: string[];
}

export interface FilesGitStatusEvent {
  root: string;
  map: GitStatusMap;
}

export interface ExternalPlace {
  id: 'downloads' | 'recent' | 'screenshots';
  label: string;
  /** Absolute folder; null for Recent, which is a list of files from several folders. */
  path: string | null;
  /** Folder that bounds navigation upwards (the home folder). */
  root: string;
}

export interface ExternalEntry {
  name: string;
  /** Absolute path. */
  path: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
}

/** Preview of one file outside the project, shown in the import dialog. */
export type ExternalPreview =
  | { kind: 'image'; dataUrl: string; mime: string; size: number; mtimeMs: number }
  | { kind: 'text'; text: string; truncated: boolean; size: number; mtimeMs: number }
  | { kind: 'none'; size: number; mtimeMs: number; reason: string };

export interface FilesApi {
  listDir(root: string, relDir: string): Promise<DirEntry[]>;
  gitStatus(root: string): Promise<GitStatusMap>;
  branch(root: string): Promise<GitBranch | null>;
  search(root: string, query: string, limit?: number): Promise<SearchResult[]>;
  watch(root: string): Promise<void>;
  unwatch(root: string): Promise<void>;
  reveal(root: string, relPath: string): Promise<void>;
  op(root: string, op: FileOp): Promise<void>;
  externalPlaces(): Promise<ExternalPlace[]>;
  /** `path` null lists the Recent place. */
  externalList(path: string | null): Promise<ExternalEntry[]>;
  /** Copies absolute source files into `relDir`; returns the created project-relative paths. */
  importFiles(root: string, relDir: string, sources: string[]): Promise<string[]>;
  /** Preview of an absolute file under the home folder. */
  externalPreview(path: string): Promise<ExternalPreview>;
  /** Absolute paths of files currently on the clipboard (copied in Finder); [] when none. */
  clipboardFiles(): Promise<string[]>;
  /** Puts absolute paths on the clipboard as files (Finder pastes them) and as text. */
  copyToClipboard(paths: string[]): Promise<void>;
  /** Absolute path of a File dropped from Finder (a DOM File; typed loosely because this file has no DOM types). */
  pathForFile(file: unknown): string;
  onChanged(listener: (event: FilesChangedEvent) => void): () => void;
  onGitStatus(listener: (event: FilesGitStatusEvent) => void): () => void;
}

export const HEAVY_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  '.next',
  'build',
  'out',
  '.cache',
  '__pycache__',
  '.venv',
]);
