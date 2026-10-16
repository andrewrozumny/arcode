/**
 * Routes paths handed to the app from outside (`open -a Acode <path>`, Finder, a second
 * launch) to project windows: folders open as projects, files open in the window whose
 * root contains them, or in a new window for the enclosing git repository.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { BrowserWindow } from 'electron';
import { IdeChannel } from '@shared/ide-ipc';
import type { IdeOpenFileMessage } from '@shared/ide-ipc';

/** Longest open root that contains `path` (or equals it), or null. */
export function pickWindowRoot(path: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const inside = path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
    if (inside && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

/** Nearest ancestor (starting at `dir` itself) that holds a `.git` entry, or null. */
export function findEnclosingRepo(dir: string, exists: (path: string) => boolean = existsSync): string | null {
  let current = dir;
  for (;;) {
    if (exists(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Paths among `argv` that exist on disk (Electron's own flags and the binary are skipped). */
export function pathsFromArgv(argv: readonly string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => resolve(cwd, arg))
    .filter((path) => existsSync(path));
}

export interface OpenTargets {
  roots(): string[];
  openProject(root: string): BrowserWindow;
}

/** Delivers the open-file message once the renderer of a fresh window can receive it. */
function sendOpenFile(win: BrowserWindow, filePath: string): void {
  const message: IdeOpenFileMessage = { filePath };
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IdeChannel.OpenFile, message);
  };
  if (win.webContents.isLoading()) {
    // The viewer subscribes in a mount effect; give React a moment after the load event.
    win.webContents.once('did-finish-load', () => setTimeout(send, 300));
  } else {
    send();
  }
}

export class OpenRequestRouter {
  private targets: OpenTargets | undefined;
  private readonly queued: string[] = [];

  /** Before this is called, requests are queued (macOS sends `open-file` before `ready`). */
  attach(targets: OpenTargets): void {
    this.targets = targets;
    for (const path of this.queued.splice(0)) this.open(path);
  }

  /** True when at least one queued or routed request was a real path. */
  open(rawPath: string): boolean {
    // `/a/b/` and `/a/b` must be the same project, not two windows on one folder.
    const path = isAbsolute(rawPath) ? resolve(rawPath) : rawPath;
    if (!this.targets) {
      this.queued.push(path);
      return true;
    }
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      return false;
    }
    if (isDir) {
      this.targets.openProject(path);
      return true;
    }
    const root =
      pickWindowRoot(path, this.targets.roots()) ?? findEnclosingRepo(dirname(path)) ?? dirname(path);
    const win = this.targets.openProject(root);
    sendOpenFile(win, path);
    return true;
  }

  openAll(paths: readonly string[]): boolean {
    let any = false;
    for (const path of paths) any = this.open(path) || any;
    return any;
  }
}
