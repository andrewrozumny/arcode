import { shell } from 'electron';
import type { IpcMain, WebContents } from 'electron';
import { ViewerChannel } from '@shared/viewer';
import type { FileChangedEvent, WriteFileResult } from '@shared/viewer';
import { resolveInside } from '../files/paths';
import { projectRoot, text } from '../ipcArgs';
import type { LocalHistory } from './history';
import { headContent, readFile, watchFile, writeFile } from './service';

/**
 * Registers viewer IPC handlers. Returns a function that removes them again. With `history`, saves
 * and outside changes of watched files keep local history snapshots, and the history channels work.
 */
export function registerViewerIpc(ipcMain: IpcMain, history?: LocalHistory): () => void {
  const watchers = new Map<string, () => void>();
  /** Bumped by every watch/unwatch of a key, so a watch that finished resolving after an unwatch is dropped. */
  const generations = new Map<string, number>();
  const bump = (key: string): number => {
    const next = (generations.get(key) ?? 0) + 1;
    generations.set(key, next);
    return next;
  };
  const tracked = new WeakSet<WebContents>();
  const watchKey = (sender: WebContents, root: string, relPath: string): string =>
    `${sender.id}\0${root}\0${relPath}`;

  // Read, write and HEAD report failures in their result; only malformed arguments reject.
  ipcMain.handle(ViewerChannel.ReadFile, (_e, root: unknown, relPath: unknown) =>
    readFile(text(root, 'project root'), text(relPath, 'path')),
  );
  ipcMain.handle(
    ViewerChannel.WriteFile,
    (_e, root: unknown, relPath: unknown, content: unknown, expectedMtime: unknown) => {
      if (expectedMtime !== null && typeof expectedMtime !== 'number') throw new Error('Invalid mtime');
      const rootText = text(root, 'project root');
      return writeFile(rootText, text(relPath, 'path'), text(content, 'content'), expectedMtime, history?.writeHooks(rootText));
    },
  );
  ipcMain.handle(ViewerChannel.HeadContent, (_e, root: unknown, relPath: unknown) =>
    headContent(text(root, 'project root'), text(relPath, 'path')),
  );

  ipcMain.handle(ViewerChannel.WatchFile, async (event, rawRoot: unknown, rawRelPath: unknown) => {
    const root = text(rawRoot, 'project root');
    const relPath = text(rawRelPath, 'path');
    const sender = event.sender;
    const key = watchKey(sender, root, relPath);
    const generation = bump(key);
    const abs = await resolveInside(root, relPath);
    if (generations.get(key) !== generation || sender.isDestroyed()) return;
    watchers.get(key)?.();
    void history?.prime(abs);
    const dispose = watchFile(abs, (mtime) => {
      void history?.externalChange(root, abs);
      if (sender.isDestroyed()) return;
      const payload: FileChangedEvent = { root, relPath, mtime };
      sender.send(ViewerChannel.FileChanged, payload);
    });
    watchers.set(key, dispose);
    if (!tracked.has(sender)) {
      // One listener per window: a listener per watched file would pile up with every opened tab.
      tracked.add(sender);
      sender.once('destroyed', () => {
        tracked.delete(sender);
        const prefix = `${sender.id}\0`;
        for (const [k, stop] of watchers) {
          if (!k.startsWith(prefix)) continue;
          stop();
          watchers.delete(k);
        }
        for (const k of generations.keys()) if (k.startsWith(prefix)) generations.delete(k);
      });
    }
  });

  ipcMain.handle(ViewerChannel.UnwatchFile, (event, root: unknown, relPath: unknown) => {
    const key = watchKey(event.sender, text(root, 'project root'), text(relPath, 'path'));
    bump(key);
    watchers.get(key)?.();
    watchers.delete(key);
  });

  ipcMain.handle(ViewerChannel.OpenDefault, async (_e, root: unknown, relPath: unknown) => {
    await shell.openPath(await resolveInside(text(root, 'project root'), text(relPath, 'path')));
  });
  ipcMain.handle(ViewerChannel.Reveal, async (_e, root: unknown, relPath: unknown) => {
    shell.showItemInFolder(await resolveInside(text(root, 'project root'), text(relPath, 'path')));
  });

  const requireHistory = (): LocalHistory => {
    if (!history) throw new Error('Local history is not available');
    return history;
  };
  ipcMain.handle(ViewerChannel.ListSnapshots, async (_e, rawRoot: unknown, relPath: unknown) => {
    const root = await projectRoot(rawRoot);
    return requireHistory().list(root, await resolveInside(root, text(relPath, 'path')));
  });
  ipcMain.handle(ViewerChannel.ReadSnapshot, async (_e, rawRoot: unknown, relPath: unknown, id: unknown) => {
    const root = await projectRoot(rawRoot);
    return requireHistory().read(root, await resolveInside(root, text(relPath, 'path')), text(id, 'snapshot'));
  });
  ipcMain.handle(
    ViewerChannel.RestoreSnapshot,
    async (_e, rawRoot: unknown, rawRelPath: unknown, id: unknown, expectedMtime: unknown): Promise<WriteFileResult> => {
      if (expectedMtime !== null && typeof expectedMtime !== 'number') throw new Error('Invalid mtime');
      const root = await projectRoot(rawRoot);
      const relPath = text(rawRelPath, 'path');
      const store = requireHistory();
      const content = await store.read(root, await resolveInside(root, relPath), text(id, 'snapshot'));
      if (content === null) return { ok: false, reason: 'error', message: 'This version is no longer in local history' };
      // Forced: the content being replaced is always kept, whatever the save throttle says.
      return writeFile(root, relPath, content, expectedMtime, store.writeHooks(root, true));
    },
  );

  return () => {
    for (const channel of [
      ViewerChannel.ReadFile,
      ViewerChannel.WriteFile,
      ViewerChannel.HeadContent,
      ViewerChannel.WatchFile,
      ViewerChannel.UnwatchFile,
      ViewerChannel.OpenDefault,
      ViewerChannel.Reveal,
      ViewerChannel.ListSnapshots,
      ViewerChannel.ReadSnapshot,
      ViewerChannel.RestoreSnapshot,
    ]) {
      ipcMain.removeHandler(channel);
    }
    for (const dispose of watchers.values()) dispose();
    watchers.clear();
    generations.clear();
  };
}
