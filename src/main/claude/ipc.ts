import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { IpcMain } from 'electron';
import { ClaudeChannel } from '@shared/claude';
import type { LiveUsage } from '@shared/claude';
import { projectRoot, text } from '../ipcArgs';
import { listAgents } from './agents';
import { feedRequest, readFeed } from './feed';
import { readGatesOverview } from './gates';
import { listHooks } from './hooks';
import { listMcp, listMcpConfigured } from './mcp';
import { readConfigFile } from './configFile';
import { listMemory } from './memory';
import { listPlugins } from './plugins';
import { listSessions } from './sessions';
import { listSkills } from './skills';
import { listSubagents } from './subagents';
import { legacyStatusLineScript } from '../legacy';
import { SCRIPT_NAME, disableStatusLine, enableStatusLine, installScript, migrateLegacyStatusLine, readStatusLineState } from './statusline';
import type { StatusLinePaths } from './statusline';
import { summarizeUsage } from './usage';
import { LiveUsageWatcher } from './usageLive';

function statusLinePaths(): StatusLinePaths {
  const source = app.isPackaged
    ? join(process.resourcesPath, SCRIPT_NAME)
    : join(app.getAppPath(), 'resources', SCRIPT_NAME);
  return {
    source,
    installed: join(app.getPath('userData'), SCRIPT_NAME),
    settings: join(homedir(), '.claude', 'settings.json'),
  };
}

function broadcast(records: LiveUsage[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(ClaudeChannel.UsageLiveEvent, records);
  }
}

/**
 * Live plan usage from the status line script. Call once after `app.whenReady()`.
 * Only ARcode's own data folder is written here; the Claude settings change on user action alone.
 */
export function startLiveUsage(ipcMain: IpcMain): LiveUsageWatcher {
  const paths = statusLinePaths();
  try {
    migrateLegacyStatusLine(paths, legacyStatusLineScript(app.getPath('appData')));
  } catch (error) {
    console.warn('[arcode] status line migration failed', error);
  }
  try {
    // Keep the installed copy current for users who already enabled it; harmless otherwise.
    if (readStatusLineState(paths).state === 'acode') installScript(paths);
  } catch (error) {
    console.warn('[arcode] status line script refresh failed', error);
  }
  const watcher = new LiveUsageWatcher(join(app.getPath('userData'), 'usage'), broadcast);
  watcher.start();
  ipcMain.handle(ClaudeChannel.UsageLive, () => watcher.snapshot());
  ipcMain.handle(ClaudeChannel.StatusLineState, () => readStatusLineState(paths));
  ipcMain.handle(ClaudeChannel.StatusLineEnable, () => enableStatusLine(paths));
  ipcMain.handle(ClaudeChannel.StatusLineDisable, () => disableStatusLine(paths));
  return watcher;
}

/** Registers the read-only `claude:*` handlers. Every handler that takes a root checks it is a project folder. */
export function registerClaudeIpc(ipcMain: IpcMain): void {
  const byRoot = <T>(channel: string, read: (root: string, home: string) => T | Promise<T>): void => {
    ipcMain.handle(channel, async (_e, root: unknown) => read(await projectRoot(root), homedir()));
  };
  byRoot(ClaudeChannel.Skills, listSkills);
  byRoot(ClaudeChannel.Plugins, listPlugins);
  byRoot(ClaudeChannel.Mcp, listMcp);
  byRoot(ClaudeChannel.McpConfigured, listMcpConfigured);
  ipcMain.handle(ClaudeChannel.ReadConfigFile, async (_e, root: unknown, path: unknown) =>
    readConfigFile(await projectRoot(root), text(path, 'path'), homedir()),
  );
  byRoot(ClaudeChannel.Usage, (root, home) => summarizeUsage(root, home));
  byRoot(ClaudeChannel.Agents, listAgents);
  byRoot(ClaudeChannel.Hooks, listHooks);
  byRoot(ClaudeChannel.Memory, listMemory);
  byRoot(ClaudeChannel.Sessions, listSessions);
  byRoot(ClaudeChannel.Gates, (root) => readGatesOverview(root));
  ipcMain.handle(ClaudeChannel.Subagents, (_e, sessionId: unknown) => listSubagents(text(sessionId, 'session id'), homedir()));
  ipcMain.handle(ClaudeChannel.Feed, (_e, request: unknown) => readFeed(feedRequest(request), homedir()));
}
