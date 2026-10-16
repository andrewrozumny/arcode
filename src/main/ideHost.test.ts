import { describe, expect, it, vi } from 'vitest';
import { IdeChannel } from '@shared/ide-ipc';
import type { IdeOpenDiffMessage, IdeStatus } from '@shared/ide-ipc';
import type { IdeHost } from '@shared/ide';
import { IdeSession, IdeWindowHost, registerIdeIpc } from './ideHost';
import type { IdeBridgeLike, IpcMainLike } from './ideHost';

/** Records what main sends to the renderer. */
class FakeContents {
  readonly id = 7;
  destroyed = false;
  readonly sent: { channel: string; args: unknown[] }[] = [];
  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  last(channel: string): unknown {
    return [...this.sent].reverse().find((m) => m.channel === channel)?.args[0];
  }
}

type Listener = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;

/** Minimal ipcMain: `emit` plays a renderer message, `invoke` a renderer invoke. */
class FakeIpcMain implements IpcMainLike {
  private readonly listeners = new Map<string, Listener>();
  private readonly handlers = new Map<string, Listener>();
  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener);
  }
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  emit(sender: { id: number }, channel: string, ...args: unknown[]): void {
    this.listeners.get(channel)?.({ sender }, ...args);
  }
  invoke(sender: { id: number }, channel: string, ...args: unknown[]): unknown {
    return this.handlers.get(channel)?.({ sender }, ...args);
  }
}

class FakeBridge implements IdeBridgeLike {
  port = 0;
  started = false;
  stopped = false;
  readonly bridge = { clientCount: 0 };
  readonly selections: unknown[] = [];
  readonly mentions: unknown[] = [];
  host: IdeHost | undefined;
  connect: (() => void) | undefined;
  disconnect: (() => void) | undefined;
  start(): Promise<void> {
    this.started = true;
    this.port = 41234;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
  notifySelectionChanged(payload: unknown): void {
    this.selections.push(payload);
  }
  notifyAtMentioned(payload: unknown): void {
    this.mentions.push(payload);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(readText: (path: string) => Promise<string> = async () => '') {
  const contents = new FakeContents();
  const fake = new FakeBridge();
  const focus = vi.fn();
  const session = new IdeSession({
    root: '/work/app',
    target: contents,
    focus,
    readText,
    createBridge: (host, callbacks) => {
      fake.host = host;
      fake.connect = callbacks.onClientConnected;
      fake.disconnect = callbacks.onClientDisconnected;
      return fake;
    },
  });
  const ipc = new FakeIpcMain();
  registerIdeIpc(ipc, (sender) => (sender.id === contents.id ? session : undefined));
  return { contents, fake, focus, session, ipc };
}

describe('IdeWindowHost', () => {
  const diff = {
    oldFilePath: '/work/app/README.md',
    newFilePath: '/work/app/README.md',
    newFileContents: 'new\n',
    tabName: 'README.md (edit)',
  };

  it('resolves openDiff with the renderer answer for the same requestId', async () => {
    const reading = vi.fn(async () => 'old\n');
    const { contents, fake, ipc, session } = setup(reading);
    await session.start();

    // The bridge calls the host it was created with.
    const pending = (fake.host as IdeHost).openDiff(diff);
    await tick();
    const message = contents.last(IdeChannel.OpenDiff) as IdeOpenDiffMessage;
    expect(message).toMatchObject({ tabName: diff.tabName, oldContent: 'old\n', newContent: 'new\n' });
    expect(reading).toHaveBeenCalledWith('/work/app/README.md');

    // An answer for another request id changes nothing.
    ipc.emit({ id: contents.id }, IdeChannel.OpenDiffResult, { requestId: message.requestId + 1, result: { result: 'rejected' } });
    expect(session.host.pendingCount).toBe(1);

    ipc.emit({ id: contents.id }, IdeChannel.OpenDiffResult, {
      requestId: message.requestId,
      result: { result: 'saved', contents: 'new\nedited\n' },
    });
    await expect(pending).resolves.toEqual({ result: 'saved', contents: 'new\nedited\n' });
    expect(session.host.pendingCount).toBe(0);
  });

  it('resolves every pending diff as closed when the window goes away', async () => {
    const { contents, session } = setup();
    await session.start();
    const first = session.host.openDiff(diff);
    const second = session.host.openDiff({ ...diff, tabName: 'other' });
    await tick();
    expect(contents.sent.filter((m) => m.channel === IdeChannel.OpenDiff)).toHaveLength(2);

    await session.stop();
    await expect(first).resolves.toEqual({ result: 'closed' });
    await expect(second).resolves.toEqual({ result: 'closed' });
    // After the window is gone a new diff does not wait for anyone.
    await expect(session.host.openDiff(diff)).resolves.toEqual({ result: 'closed' });
  });

  it('answers closed when the renderer is already destroyed', async () => {
    const contents = new FakeContents();
    contents.destroyed = true;
    const host = new IdeWindowHost(contents, { root: '/r', focus: () => undefined, readText: async () => '' });
    await expect(host.openDiff(diff)).resolves.toEqual({ result: 'closed' });
    expect(contents.sent).toHaveLength(0);
  });

  it('routes openFile, closeTab and closeAllDiffTabs to the renderer', () => {
    const contents = new FakeContents();
    const focus = vi.fn();
    const host = new IdeWindowHost(contents, { root: '/work/app', focus });
    host.openFile({ filePath: 'src/a.ts', makeFrontmost: false });
    expect(contents.last(IdeChannel.OpenFile)).toEqual({ filePath: '/work/app/src/a.ts' });
    expect(focus).not.toHaveBeenCalled();
    host.openFile({ filePath: '/abs/b.ts', makeFrontmost: true });
    expect(contents.last(IdeChannel.OpenFile)).toEqual({ filePath: '/abs/b.ts' });
    expect(focus).toHaveBeenCalledTimes(1);
    host.closeTab('t1');
    expect(contents.last(IdeChannel.CloseTab)).toEqual({ tabName: 't1' });
    host.closeAllDiffTabs();
    expect(contents.sent.at(-1)?.channel).toBe(IdeChannel.CloseAllDiffTabs);
  });
});

describe('registerIdeIpc', () => {
  it('turns viewer selections into selection_changed payloads', async () => {
    const { contents, fake, ipc, session } = setup();
    await session.start();
    ipc.emit({ id: contents.id }, IdeChannel.SelectionChanged, {
      filePath: '/work/app/a.ts',
      selection: { start: { line: 1, character: 2 }, end: { line: 3, character: 0 } },
      text: 'xy',
    });
    expect(fake.selections).toEqual([
      {
        text: 'xy',
        filePath: '/work/app/a.ts',
        fileUrl: 'file:///work/app/a.ts',
        selection: { start: { line: 1, character: 2 }, end: { line: 3, character: 0 }, isEmpty: false },
      },
    ]);
  });

  it('forwards at-mentions with lines only when both are present', async () => {
    const { contents, fake, ipc, session } = setup();
    await session.start();
    ipc.emit({ id: contents.id }, IdeChannel.AtMentioned, { filePath: '/f', lineStart: 2, lineEnd: 4 });
    ipc.emit({ id: contents.id }, IdeChannel.AtMentioned, { filePath: '/g', lineStart: 2 });
    expect(fake.mentions).toEqual([{ filePath: '/f', lineStart: 2, lineEnd: 4 }, { filePath: '/g' }]);
  });

  it('ignores messages from unknown windows', async () => {
    const { fake, ipc, session } = setup();
    await session.start();
    ipc.emit({ id: 999 }, IdeChannel.AtMentioned, { filePath: '/f' });
    expect(fake.mentions).toHaveLength(0);
    expect(ipc.invoke({ id: 999 }, IdeChannel.GetStatus)).toEqual({ port: 0, clients: 0 });
  });

  it('reports status on start and on client changes, and stops the bridge', async () => {
    const { contents, fake, ipc, session } = setup();
    await session.start();
    expect(contents.last(IdeChannel.Status)).toEqual({ port: 41234, clients: 0 });
    fake.bridge.clientCount = 1;
    fake.connect?.();
    expect(contents.last(IdeChannel.Status)).toEqual({ port: 41234, clients: 1 });
    expect(ipc.invoke({ id: contents.id }, IdeChannel.GetStatus)).toEqual<IdeStatus>({ port: 41234, clients: 1 });
    fake.bridge.clientCount = 0;
    fake.disconnect?.();
    expect(contents.last(IdeChannel.Status)).toEqual({ port: 41234, clients: 0 });
    await session.stop();
    expect(fake.stopped).toBe(true);
    expect(session.port).toBe(0);
  });
});
