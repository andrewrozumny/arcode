import os from 'node:os';
import { shell } from 'electron';
import type { IpcMain, WebContents } from 'electron';
import { FilesChannel } from '@shared/files';
import type { FileOp, FilesChangedEvent, FilesGitStatusEvent, GrepQuery } from '@shared/files';
import { getChanges } from './changes';
import { getBranch } from './git';
import { grepProject } from './grep';
import { getGitStatus } from './gitStatus';
import { dropIndex, getIndex, invalidateIndex, search } from './index';
import { importFiles, listExternal, previewExternal, readScreenshotLocation, resolvePlaces } from './external';
import { resolveEntryInside, resolveInside } from './paths';
import { applyFileOp, listDir } from './service';
import { readClipboardFiles, writeFilesToClipboard } from './clipboard';
import { isRecord } from '@shared/guards';
import { flag, integer, projectRoot, text, textList, textOrNull } from '../ipcArgs';
import { watchProject } from './watcher';
import type { ProjectWatcher } from './watcher';

interface Subscription {
  watcher: ProjectWatcher;
  sender: WebContents;
  root: string;
}

const subscriptions = new Map<string, Subscription>();

function keyOf(sender: WebContents, root: string): string {
  return `${sender.id}\0${root}`;
}

function unsubscribe(key: string): void {
  const sub = subscriptions.get(key);
  if (!sub) return;
  sub.watcher.close();
  subscriptions.delete(key);
  const stillWatched = [...subscriptions.values()].some((s) => s.root === sub.root);
  if (!stillWatched) dropIndex(sub.root);
}

/** A FileOp from the renderer, checked field by field. */
function fileOp(value: unknown): FileOp {
  if (!isRecord(value)) throw new Error('Invalid file operation');
  const relPath = text(value.relPath, 'path');
  switch (value.type) {
    case 'createFile':
    case 'createDir':
    case 'delete':
      return { type: value.type, relPath };
    case 'rename':
      return { type: 'rename', relPath, newRelPath: text(value.newRelPath, 'new path') };
    default:
      throw new Error('Invalid file operation');
  }
}

const MAX_GREP_QUERY = 1000;

/** A GrepQuery from the renderer, checked field by field. */
export function grepQuery(value: unknown): GrepQuery {
  if (!isRecord(value)) throw new Error('Invalid search query');
  const query = text(value.query, 'query');
  const include = text(value.include, 'include');
  if (query.length > MAX_GREP_QUERY || include.length > MAX_GREP_QUERY) throw new Error('Search query too long');
  return {
    query,
    include,
    caseSensitive: flag(value.caseSensitive, 'case sensitive'),
    wholeWord: flag(value.wholeWord, 'whole word'),
    regex: flag(value.regex, 'regex'),
  };
}

/** The running Find in files query of each window (by WebContents id); a new one aborts it. */
const greps = new Map<number, AbortController>();

/** Registers all `files:*` handlers. */
export function registerFilesIpc(ipcMain: IpcMain): void {
  ipcMain.handle(FilesChannel.Grep, async (event, rawRoot: unknown, rawQuery: unknown) => {
    const id = event.sender.id;
    greps.get(id)?.abort();
    const controller = new AbortController();
    greps.set(id, controller);
    try {
      const root = await projectRoot(rawRoot);
      return await grepProject(root, grepQuery(rawQuery), { signal: controller.signal });
    } finally {
      if (greps.get(id) === controller) greps.delete(id);
    }
  });

  ipcMain.handle(FilesChannel.ListDir, async (_e, root: unknown, relDir: unknown) =>
    listDir(await projectRoot(root), text(relDir, 'folder')),
  );
  ipcMain.handle(FilesChannel.GitStatus, async (_e, root: unknown) => getGitStatus(await projectRoot(root)));
  ipcMain.handle(FilesChannel.Changes, async (_e, root: unknown) => getChanges(await projectRoot(root)));
  ipcMain.handle(FilesChannel.Branch,async (_e, root: unknown) => getBranch(await projectRoot(root)));
  ipcMain.handle(FilesChannel.Search, async (_e, root: unknown, query: unknown, limit: unknown) =>
    search(await projectRoot(root), text(query, 'query'), limit === undefined || limit === null ? 50 : integer(limit, 'limit')),
  );

  // Watch and Unwatch stay synchronous so an unwatch can never overtake its watch.
  ipcMain.handle(FilesChannel.Watch, (event, rawRoot: unknown) => {
    const root = text(rawRoot, 'project root');
    const sender = event.sender;
    const key = keyOf(sender, root);
    if (subscriptions.has(key)) return;
    // Warm the fuzzy index so the first palette query is instant.
    void getIndex(root).catch(() => undefined);
    const watcher = watchProject(root, {
      onBatch: (batch) => {
        if (sender.isDestroyed()) {
          unsubscribe(key);
          return;
        }
        if (batch.structural || batch.git) invalidateIndex(root);
        if (batch.paths.length > 0) {
          const payload: FilesChangedEvent = { root, paths: batch.paths };
          sender.send(FilesChannel.Changed, payload);
        }
        if (batch.git) {
          void getGitStatus(root).then((map) => {
            if (sender.isDestroyed()) return;
            const payload: FilesGitStatusEvent = { root, map };
            sender.send(FilesChannel.GitStatusEvent, payload);
          });
        }
      },
    });
    subscriptions.set(key, { watcher, sender, root });
    sender.once('destroyed', () => unsubscribe(key));
  });

  ipcMain.handle(FilesChannel.Unwatch, (event, root: unknown) =>
    unsubscribe(keyOf(event.sender, text(root, 'project root'))),
  );

  ipcMain.handle(FilesChannel.Reveal, async (_e, root: unknown, relPath: unknown) => {
    shell.showItemInFolder(await resolveInside(await projectRoot(root), text(relPath, 'path')));
  });

  ipcMain.handle(FilesChannel.ExternalPlaces, async () => {
    const home = os.homedir();
    return resolvePlaces(home, await readScreenshotLocation(home));
  });

  ipcMain.handle(FilesChannel.ExternalList, (_e, path: unknown) => listExternal(os.homedir(), textOrNull(path, 'path')));

  ipcMain.handle(FilesChannel.ExternalPreview, (_e, path: unknown) => previewExternal(os.homedir(), text(path, 'path')));

  ipcMain.handle(FilesChannel.Import, async (_e, root: unknown, relDir: unknown, sources: unknown) =>
    importFiles(await projectRoot(root), text(relDir, 'folder'), textList(sources, 'files')),
  );

  ipcMain.handle(FilesChannel.ClipboardFiles, () => readClipboardFiles());
  ipcMain.handle(FilesChannel.CopyToClipboard, (_e, paths: unknown) => writeFilesToClipboard(paths));

  ipcMain.handle(FilesChannel.Op, async (_e, rawRoot: unknown, rawOp: unknown) => {
    const root = await projectRoot(rawRoot);
    const op = fileOp(rawOp);
    if (op.type === 'delete') {
      // The entry itself (a symlink pointing outside included) goes to the Trash; the root never does.
      await shell.trashItem(await resolveEntryInside(root, op.relPath));
      return;
    }
    await applyFileOp(root, op);
  });
}
