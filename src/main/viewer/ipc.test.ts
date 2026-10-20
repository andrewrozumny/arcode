import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { ViewerChannel } from '@shared/viewer';
import type { SnapshotInfo } from '@shared/viewer';

vi.mock('electron', () => ({ shell: {} }));

const { registerViewerIpc } = await import('./ipc');
const { LocalHistory } = await import('./history');

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

describe('registerViewerIpc', () => {
  it('adds one destroyed listener per window, not one per watched file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'viewer-ipc-'));
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send: () => undefined });
    const dispose = registerViewerIpc(ipcMain);
    try {
      const watch = handlers.get(ViewerChannel.WatchFile);
      const unwatch = handlers.get(ViewerChannel.UnwatchFile);
      for (let i = 0; i < 25; i++) {
        writeFileSync(join(root, `f${i}.txt`), 'x');
        await watch?.({ sender }, root, `f${i}.txt`);
        await unwatch?.({ sender }, root, `f${i}.txt`);
      }
      expect(sender.listenerCount('destroyed')).toBe(1);
    } finally {
      dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a watch that an unwatch overtook while its path was being resolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'viewer-ipc-race-'));
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const sender = Object.assign(new EventEmitter(), { id: 8, isDestroyed: () => false, send: () => undefined });
    const dispose = registerViewerIpc(ipcMain);
    try {
      writeFileSync(join(root, 'a.txt'), 'x');
      const watching = handlers.get(ViewerChannel.WatchFile)?.({ sender }, root, 'a.txt');
      await handlers.get(ViewerChannel.UnwatchFile)?.({ sender }, root, 'a.txt');
      await watching;
      expect(sender.listenerCount('destroyed')).toBe(0);
    } finally {
      dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores a snapshot through the guarded write and keeps the replaced content', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'viewer-ipc-history-'));
    const root = join(tmp, 'project');
    mkdirSync(root);
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const dispose = registerViewerIpc(ipcMain, new LocalHistory(join(tmp, 'history')));
    const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
      Promise.resolve(handlers.get(channel)?.({ sender: null }, ...args));
    try {
      const abs = join(root, 'a.txt');
      writeFileSync(abs, 'first');
      await call(ViewerChannel.WriteFile, root, 'a.txt', 'second', statSync(abs).mtimeMs);
      const [first] = (await call(ViewerChannel.ListSnapshots, root, 'a.txt')) as SnapshotInfo[];
      const id = first?.id ?? '';
      expect(await call(ViewerChannel.ReadSnapshot, root, 'a.txt', id)).toBe('first');

      // A stale mtime is a conflict, as for any save.
      expect(await call(ViewerChannel.RestoreSnapshot, root, 'a.txt', id, 1)).toMatchObject({ reason: 'conflict' });
      const result = await call(ViewerChannel.RestoreSnapshot, root, 'a.txt', id, statSync(abs).mtimeMs);
      expect(result).toMatchObject({ ok: true });
      expect(readFileSync(abs, 'utf-8')).toBe('first');
      const list = (await call(ViewerChannel.ListSnapshots, root, 'a.txt')) as SnapshotInfo[];
      expect(await call(ViewerChannel.ReadSnapshot, root, 'a.txt', list[0]?.id ?? '')).toBe('second');

      await expect(call(ViewerChannel.ListSnapshots, root, '../outside.txt')).rejects.toThrow(/escapes/);
      await expect(call(ViewerChannel.ReadSnapshot, root, 'a.txt', '../x')).rejects.toThrow(/Invalid snapshot/);
      await expect(call(ViewerChannel.ListSnapshots, 'relative/root', 'a.txt')).rejects.toThrow(/Not a project folder/);
    } finally {
      dispose();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
