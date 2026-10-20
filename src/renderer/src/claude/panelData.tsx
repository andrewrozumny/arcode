import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type {
  AgentInfo,
  HookInfo,
  McpServerInfo,
  MemoryFile,
  PluginInfo,
  SessionSummary,
  SkillInfo,
  StatusLineState,
} from '@shared/claude';
import { claudeApi } from './api';
import type { SectionId } from './panelModel';
import { useLoad } from './useLoad';
import type { Loaded } from './useLoad';

/**
 * Everything the panel's sections share, loaded once when the panel opens so the overview, the
 * navigation counts and each section agree. All reads; nothing here writes to ~/.claude.
 */
export interface PanelData {
  root: string;
  home: string;
  skills: Loaded<SkillInfo[]>;
  agents: Loaded<AgentInfo[]>;
  plugins: Loaded<PluginInfo[]>;
  hooks: Loaded<HookInfo[]>;
  memory: Loaded<MemoryFile[]>;
  sessions: Loaded<SessionSummary[]>;
  statusLine: Loaded<StatusLineState>;
  /** Servers from the settings files, with state 'unknown' until checked. */
  mcpConfigured: Loaded<McpServerInfo[]>;
  /** Result of `claude mcp list`, run only on request. */
  mcpStatus: Loaded<McpServerInfo[]>;
  /** The checked list when there is one, else the configured list. */
  mcp: McpServerInfo[] | null;
  reloadAll(): void;
  go(section: SectionId): void;
}

const PanelContext = createContext<PanelData | null>(null);

export function usePanel(): PanelData {
  const value = useContext(PanelContext);
  if (!value) throw new Error('usePanel outside the Claude panel');
  return value;
}

export function PanelDataProvider({ root, go, children }: { root: string; go(section: SectionId): void; children: ReactNode }) {
  const skills = useLoad(() => claudeApi().skills(root), true);
  const agents = useLoad(() => claudeApi().agents(root), true);
  const plugins = useLoad(() => claudeApi().plugins(root), true);
  const hooks = useLoad(() => claudeApi().hooks(root), true);
  const memory = useLoad(() => claudeApi().memory(root), true);
  const sessions = useLoad(() => claudeApi().sessions(root), true);
  const statusLine = useLoad(() => claudeApi().statusLineState(), true);
  const mcpConfigured = useLoad(() => claudeApi().mcpConfigured(root), true);
  const mcpStatus = useLoad(() => claudeApi().mcp(root), false);

  const reloadAll = (): void => {
    for (const loaded of [skills, agents, plugins, hooks, memory, sessions, statusLine, mcpConfigured]) loaded.reload();
    // The status check spawns the CLI, so it runs again only when it already ran once.
    if (mcpStatus.data !== null) mcpStatus.reload();
  };

  const home = useMemo(() => window.acode.app.context().home, []);
  const value: PanelData = {
    root,
    home,
    skills,
    agents,
    plugins,
    hooks,
    memory,
    sessions,
    statusLine,
    mcpConfigured,
    mcpStatus,
    mcp: mcpStatus.data ?? mcpConfigured.data,
    reloadAll,
    go,
  };
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}
