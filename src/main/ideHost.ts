/**
 * Per-window glue between the IDE bridge and the renderer's viewer.
 *
 * The bridge calls an `IdeHost`; this host forwards every call to the window's renderer
 * over IPC. `openDiff` waits for the renderer's answer without a timeout; when the window
 * goes away every pending diff resolves as `closed`, so the CLI never hangs.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { IdeHost, OpenDiffRequest, OpenDiffResult, OpenFileRequest } from '@shared/ide';
import { IdeChannel, toSelectionWirePayload } from '@shared/ide-ipc';
import type {
  IdeAtMentionMessage,
  IdeOpenDiffMessage,
  IdeOpenDiffResultMessage,
  IdeOpenFileMessage,
  IdeSelectionMessage,
  IdeStatus,
} from '@shared/ide-ipc';

/** The part of `WebContents` the host needs. */
export interface IdeTarget {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

export interface IdeWindowHostOptions {
  /** Project root; relative paths from the CLI resolve against it. */
  root: string;
  /** Brings the window to the front (`openFile` with `makeFrontmost`). */
  focus(): void;
  /** Reads the current file for the left side of a diff. Missing files read as ''. */
  readText?(path: string): Promise<string>;
}

const readOrEmpty = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '');

export class IdeWindowHost implements IdeHost {
  private nextId = 1;
  private readonly pending = new Map<number, (result: OpenDiffResult) => void>();
  private disposed = false;

  constructor(
    private readonly target: IdeTarget,
    private readonly options: IdeWindowHostOptions,
  ) {}

  /** Number of diffs still waiting for the user. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async openDiff(request: OpenDiffRequest): Promise<OpenDiffResult> {
    const oldPath = this.absolute(request.oldFilePath);
    const oldContent = await (this.options.readText ?? readOrEmpty)(oldPath);
    if (!this.alive()) return { result: 'closed' };
    const requestId = this.nextId++;
    const message: IdeOpenDiffMessage = {
      requestId,
      tabName: request.tabName,
      oldPath,
      newPath: this.absolute(request.newFilePath),
      oldContent,
      newContent: request.newFileContents,
    };
    return new Promise<OpenDiffResult>((resolveResult) => {
      this.pending.set(requestId, resolveResult);
      this.target.send(IdeChannel.OpenDiff, message);
    });
  }

  /** The renderer's answer to an `openDiff`. Unknown or repeated ids are ignored. */
  settle(message: IdeOpenDiffResultMessage): void {
    const resolveResult = this.pending.get(message.requestId);
    if (!resolveResult) return;
    this.pending.delete(message.requestId);
    resolveResult(normalizeResult(message.result));
  }

  closeTab(tabName: string): void {
    if (this.alive()) this.target.send(IdeChannel.CloseTab, { tabName });
  }

  closeAllDiffTabs(): void {
    if (this.alive()) this.target.send(IdeChannel.CloseAllDiffTabs);
  }

  openFile(request: OpenFileRequest): void {
    if (!this.alive() || !request.filePath) return;
    const message: IdeOpenFileMessage = { filePath: this.absolute(request.filePath) };
    this.target.send(IdeChannel.OpenFile, message);
    if (request.makeFrontmost) this.options.focus();
  }

  /** Window closed: every pending diff resolves as `closed`, later calls are no-ops. */
  dispose(): void {
    this.disposed = true;
    for (const resolveResult of this.pending.values()) resolveResult({ result: 'closed' });
    this.pending.clear();
  }

  private alive(): boolean {
    return !this.disposed && !this.target.isDestroyed();
  }

  private absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(this.options.root, path);
  }
}

function normalizeResult(value: OpenDiffResult | undefined): OpenDiffResult {
  if (value?.result === 'saved' && typeof value.contents === 'string') {
    return { result: 'saved', contents: value.contents };
  }
  if (value?.result === 'rejected') return { result: 'rejected' };
  return { result: 'closed' };
}

/** What `registerIdeIpc` needs from a window's IDE session. */
export interface IdeSessionLike {
  host: IdeWindowHost;
  status(): IdeStatus;
  notifySelectionChanged(message: IdeSelectionMessage): void;
  notifyAtMentioned(message: IdeAtMentionMessage): void;
}

/** The part of `IpcMain` used here, so tests can pass a fake. */
export interface IpcMainLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors Electron's IpcMain signature
  on(channel: string, listener: (event: { sender: { id: number } }, ...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors Electron's IpcMain signature
  handle(channel: string, listener: (event: { sender: { id: number } }, ...args: any[]) => unknown): unknown;
}

/**
 * Registers the renderer -> main side of the IDE IPC once; each message is routed to the
 * session of the window that sent it.
 */
export function registerIdeIpc(
  ipcMain: IpcMainLike,
  sessionFor: (sender: { id: number }) => IdeSessionLike | undefined,
): void {
  ipcMain.on(IdeChannel.OpenDiffResult, (event, message: IdeOpenDiffResultMessage) => {
    if (message && typeof message.requestId === 'number') sessionFor(event.sender)?.host.settle(message);
  });
  ipcMain.on(IdeChannel.SelectionChanged, (event, message: IdeSelectionMessage | null) => {
    if (message && typeof message.filePath === 'string') sessionFor(event.sender)?.notifySelectionChanged(message);
  });
  ipcMain.on(IdeChannel.AtMentioned, (event, message: IdeAtMentionMessage) => {
    if (message && typeof message.filePath === 'string') sessionFor(event.sender)?.notifyAtMentioned(message);
  });
  ipcMain.handle(
    IdeChannel.GetStatus,
    (event): IdeStatus => sessionFor(event.sender)?.status() ?? { port: 0, clients: 0 },
  );
}

/** The bridge calls a session needs; matches `createIdeBridge`'s return value. */
export interface IdeBridgeLike {
  readonly port: number;
  start(options: { workspaceFolders: string[]; ideName?: string; pid?: number }): Promise<void>;
  stop(): Promise<void>;
  notifySelectionChanged(payload: ReturnType<typeof toSelectionWirePayload>): void;
  notifyAtMentioned(payload: IdeAtMentionMessage): void;
  readonly bridge: { readonly clientCount: number };
}

export interface IdeSessionOptions {
  root: string;
  target: IdeTarget;
  focus(): void;
  createBridge(
    host: IdeHost,
    callbacks: { onClientConnected(): void; onClientDisconnected(): void; log(message: string): void },
  ): IdeBridgeLike;
  log?(message: string): void;
  /** Overrides how the left side of a diff is read (tests). */
  readText?(path: string): Promise<string>;
}

/** One project window's bridge: starts listening, reports status, stops with the window. */
export class IdeSession implements IdeSessionLike {
  readonly host: IdeWindowHost;
  private readonly bridge: IdeBridgeLike;
  private running = false;
  private stopped = false;

  constructor(private readonly options: IdeSessionOptions) {
    this.host = new IdeWindowHost(options.target, {
      root: options.root,
      focus: options.focus,
      ...(options.readText ? { readText: options.readText } : {}),
    });
    const changed = (): void => this.pushStatus();
    this.bridge = options.createBridge(this.host, {
      onClientConnected: changed,
      onClientDisconnected: changed,
      log: (message) => options.log?.(message),
    });
  }

  /** Port to give terminal sessions (`ideEnv(port)`), 0 until started. */
  get port(): number {
    return this.running ? this.bridge.port : 0;
  }

  async start(): Promise<void> {
    await this.bridge.start({ workspaceFolders: [this.options.root], ideName: 'Acode', pid: process.pid });
    if (this.stopped) {
      await this.bridge.stop();
      return;
    }
    this.running = true;
    this.pushStatus();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.host.dispose();
    if (this.running) {
      this.running = false;
      await this.bridge.stop();
    }
  }

  status(): IdeStatus {
    return this.running ? { port: this.bridge.port, clients: this.bridge.bridge.clientCount } : { port: 0, clients: 0 };
  }

  notifySelectionChanged(message: IdeSelectionMessage): void {
    if (this.running) this.bridge.notifySelectionChanged(toSelectionWirePayload(message));
  }

  notifyAtMentioned(message: IdeAtMentionMessage): void {
    if (!this.running) return;
    const { filePath, lineStart, lineEnd } = message;
    const hasLines = Number.isInteger(lineStart) && Number.isInteger(lineEnd);
    this.bridge.notifyAtMentioned(
      hasLines ? { filePath, lineStart: lineStart as number, lineEnd: lineEnd as number } : { filePath },
    );
  }

  private pushStatus(): void {
    if (!this.options.target.isDestroyed()) this.options.target.send(IdeChannel.Status, this.status());
  }
}
