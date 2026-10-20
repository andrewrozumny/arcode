import { ipcRenderer } from 'electron';
import { ClaudeChannel } from '@shared/claude';
import type { ClaudeApi, LiveUsage } from '@shared/claude';
import { subscribe } from './subscribe';

/** Exposed as `window.acode.claude` from the preload entry. */
export const claudeApi: ClaudeApi = {
  skills: (root) => ipcRenderer.invoke(ClaudeChannel.Skills, root),
  plugins: (root) => ipcRenderer.invoke(ClaudeChannel.Plugins, root),
  mcp: (root) => ipcRenderer.invoke(ClaudeChannel.Mcp, root),
  mcpConfigured: (root) => ipcRenderer.invoke(ClaudeChannel.McpConfigured, root),
  readConfigFile: (root, path) => ipcRenderer.invoke(ClaudeChannel.ReadConfigFile, root, path),
  usage: (root) => ipcRenderer.invoke(ClaudeChannel.Usage, root),
  agents: (root) => ipcRenderer.invoke(ClaudeChannel.Agents, root),
  hooks: (root) => ipcRenderer.invoke(ClaudeChannel.Hooks, root),
  memory: (root) => ipcRenderer.invoke(ClaudeChannel.Memory, root),
  sessions: (root) => ipcRenderer.invoke(ClaudeChannel.Sessions, root),
  gates: (root) => ipcRenderer.invoke(ClaudeChannel.Gates, root),
  subagents: (sessionId) => ipcRenderer.invoke(ClaudeChannel.Subagents, sessionId),
  feed: (request) => ipcRenderer.invoke(ClaudeChannel.Feed, request),
  statusLineState: () => ipcRenderer.invoke(ClaudeChannel.StatusLineState),
  statusLineEnable: () => ipcRenderer.invoke(ClaudeChannel.StatusLineEnable),
  statusLineDisable: () => ipcRenderer.invoke(ClaudeChannel.StatusLineDisable),
  usageLive: () => ipcRenderer.invoke(ClaudeChannel.UsageLive),
  onUsageLive: (listener) => subscribe<[LiveUsage[]]>(ClaudeChannel.UsageLiveEvent, listener),
};
