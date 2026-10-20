/** Main-process IPC for the terminal module: pty control plus helpers for links, clipboard, pasted images and Claude status. */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import { app, clipboard } from 'electron';
import type { BrowserWindow, IpcMain, WebContents } from 'electron';
import { isRecord } from '@shared/guards';
import { IpcChannel } from '@shared/ipc';
import type { PtyCreateOptions, PtyId } from '@shared/ipc';
import { sanitizeTabTitles, TerminalChannel } from '@shared/terminal';
import type { ClaudeStatusEvent, ClipboardInfo } from '@shared/terminal';
import { integer, isInteger, isText, textOrNull } from '../ipcArgs';
import type { PtyManager } from '../pty';
import { notifyWaiting, ownedByWindow, WaitingTransitions } from '../notifications';
import { expandPath } from './linkPaths';
import { pasteDir, savePastedImage } from './pasteImages';
import { findSessionTranscript } from '../claude/transcripts';
import { ClaudeSessionWatcher } from './sessions';

/** One project window as seen by the terminal channels. */
export interface TerminalWindow {
  win: BrowserWindow;
  ptys: PtyManager;
  /** Folder new terminals open in when the renderer does not name one. */
  projectDir(): string;
  /** Environment every pty of the window gets (e.g. the IDE bridge port); may wait for the bridge. */
  env?(): Promise<Record<string, string>>;
}

/** Finds the window that owns an IPC sender. */
export type TerminalWindowResolver = (sender: WebContents) => TerminalWindow | undefined;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function hasChildProcess(pid: number): Promise<boolean> {
  return new Promise((done) => {
    // pgrep exits 0 when at least one child matches.
    execFile('pgrep', ['-P', String(pid)], (error) => done(!error));
  });
}

function ptyOptions(value: unknown): PtyCreateOptions {
  if (!isRecord(value)) throw new Error('Invalid terminal options');
  const extraEnv: Record<string, string> = {};
  if (isRecord(value.extraEnv)) {
    for (const [key, env] of Object.entries(value.extraEnv)) if (isText(env)) extraEnv[key] = env;
  }
  return {
    cols: integer(value.cols, 'columns'),
    rows: integer(value.rows, 'rows'),
    cwd: textOrNull(value.cwd, 'cwd') ?? undefined,
    extraEnv,
    name: textOrNull(value.name, 'name') ?? undefined,
  };
}

/**
 * Registers every terminal channel once for the whole app. Each call is routed to the
 * window that sent it, so several project windows work side by side.
 */
export function registerTerminalIpc(ipcMain: IpcMain, resolve: TerminalWindowResolver): void {
  const owner = (sender: WebContents): TerminalWindow => {
    const found = resolve(sender);
    if (!found) throw new Error('Unknown sender');
    return found;
  };

  ipcMain.handle(IpcChannel.PtyCreate, async (event, rawOptions: unknown) => {
    const options = ptyOptions(rawOptions);
    const target = owner(event.sender);
    const windowEnv = (await target.env?.()) ?? {};
    // The window may have closed while the IDE bridge was starting; its ptys were already killed,
    // so a shell spawned now would be orphaned until the app quits.
    if (target.win.isDestroyed() || event.sender.isDestroyed()) throw new Error('Window closed');
    return target.ptys.create({
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd || target.projectDir(),
      // The renderer's extra env wins over the window defaults.
      extraEnv: { ...windowEnv, ...options.extraEnv },
      name: options.name,
    });
  });
  ipcMain.on(IpcChannel.PtyWrite, (event, id: unknown, data: unknown) => {
    if (isInteger(id) && isText(data)) resolve(event.sender)?.ptys.write(id, data);
  });
  ipcMain.on(IpcChannel.PtyResize, (event, id: unknown, cols: unknown, rows: unknown) => {
    if (isInteger(id) && isInteger(cols) && isInteger(rows)) resolve(event.sender)?.ptys.resize(id, cols, rows);
  });
  ipcMain.on(IpcChannel.PtyKill, (event, id: unknown) => {
    if (isInteger(id)) resolve(event.sender)?.ptys.kill(id);
  });

  ipcMain.handle(TerminalChannel.ResolveFile, async (event, path: unknown, projectRoot: unknown) => {
    const target = owner(event.sender);
    if (!isText(path) || path.length === 0 || path.length > 1024) return null;
    const absolute = expandPath(path, isText(projectRoot) && projectRoot ? projectRoot : target.projectDir());
    return (await isFile(absolute)) ? absolute : null;
  });

  ipcMain.handle(TerminalChannel.ClipboardInfo, async (event): Promise<ClipboardInfo> => {
    owner(event.sender);
    const imageTypes = await Promise.all(
      ['image/png', 'image/tiff', 'image/jpeg'].map((type) => clipboard.has(type).catch(() => false)),
    );
    const text = await clipboard.readText().catch(() => '');
    return { hasImage: imageTypes.some(Boolean), hasText: text.length > 0 };
  });

  ipcMain.handle(TerminalChannel.SavePastedImage, (event, bytes: unknown, mimeType: unknown) => {
    owner(event.sender);
    return savePastedImage(pasteDir(app.getPath('userData')), bytes, mimeType);
  });

  ipcMain.handle(TerminalChannel.HasChildren, (event, ptyId: unknown) => {
    const pid = owner(event.sender).ptys.pidOf(integer(ptyId, 'terminal id'));
    return pid === undefined ? false : hasChildProcess(pid);
  });

  ipcMain.handle(TerminalChannel.SessionExists, async (event, sessionId: unknown) => {
    owner(event.sender);
    return isText(sessionId) && (await findSessionTranscript(sessionId, os.homedir())) !== null;
  });

  ipcMain.handle(TerminalChannel.ClaudeSnapshot, (event) => watchers.get(owner(event.sender).win)?.snapshot() ?? []);

  ipcMain.on(TerminalChannel.Attention, (event, request: unknown) => {
    const target = resolve(event.sender);
    if (!target) return;
    const waiting = Math.max(0, Math.floor(Number(isRecord(request) ? request.waiting : 0) || 0));
    const previous = attention.get(target.win) ?? 0;
    attention.set(target.win, waiting);
    updateDock(waiting > previous && !target.win.isFocused());
  });

  ipcMain.on(TerminalChannel.TabTitles, (event, titles: unknown) => {
    const target = resolve(event.sender);
    if (target) tabTitles.set(target.win, sanitizeTabTitles(titles));
  });

  // Plain-text clipboard for the terminal's copy and paste and the tree's Copy Path.
  ipcMain.handle(IpcChannel.ClipboardRead, () => clipboard.readText());
  ipcMain.on(IpcChannel.ClipboardWrite, (_event, text: unknown) => {
    if (isText(text)) clipboard.writeText(text);
  });
}

const watchers = new Map<BrowserWindow, ClaudeSessionWatcher>();
/** Tabs waiting for the user, per window; the dock badge shows the sum. */
const attention = new Map<BrowserWindow, number>();
/** Tab title per pty, per window, as the renderer last reported them; notifications name the tab. */
const tabTitles = new Map<BrowserWindow, Map<PtyId, string>>();

export interface TerminalWindowOptions {
  /** Project name used as the notification title. */
  project: string;
  /** Current value of the Notification Sound setting. */
  notificationSound(): boolean;
}

function updateDock(bounce: boolean): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  let total = 0;
  for (const count of attention.values()) total += count;
  app.dock.setBadge(total > 0 ? String(total) : '');
  if (bounce) app.dock.bounce('informational');
}

/**
 * Starts the per-window part of the terminal module: the Claude session watcher that pushes
 * status to this window. Stops by itself when the window closes; also returns a disposer.
 */
export function attachTerminalWindow(win: BrowserWindow, ptys: PtyManager, options: TerminalWindowOptions): () => void {
  const transitions = new WaitingTransitions();
  const watcher = new ClaudeSessionWatcher({
    shells: () => ptys.pidMap(),
    onChange: (event: ClaudeStatusEvent) => {
      if (!win.isDestroyed()) win.webContents.send(TerminalChannel.ClaudeStatus, event);
      // Sessions of other windows or other terminal apps must not notify under this project's name.
      if (ownedByWindow(event) && transitions.observe(event)) {
        notifyWaiting(win, event, {
          project: options.project,
          tabTitle: event.ptyId === null ? undefined : tabTitles.get(win)?.get(event.ptyId),
          sound: options.notificationSound(),
          // The renderer selects the tab, showing the terminal dock first when it is hidden.
          onClick: (ptyId) => {
            if (!win.isDestroyed()) win.webContents.send(TerminalChannel.FocusPty, ptyId);
          },
        });
      }
    },
  });
  watcher.start();
  watchers.set(win, watcher);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    watcher.stop();
    watchers.delete(win);
    attention.delete(win);
    tabTitles.delete(win);
    updateDock(false);
  };
  win.on('closed', dispose);
  return dispose;
}
