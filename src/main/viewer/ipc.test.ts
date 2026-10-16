import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { ViewerChannel } from '@shared/viewer';

vi.mock('electron', () => ({ shell: {} }));

const { registerViewerIpc } = await import('./ipc');

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
});
