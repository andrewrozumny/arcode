/**
 * Pure logic of the Claude panel: section list, session buckets, overview counts, the "needs
 * attention" list and search across config items. No DOM, no window, so it runs in Vitest.
 */
import type {
  AgentInfo,
  ConfigScope,
  HookInfo,
  McpServerInfo,
  MemoryFile,
  PluginInfo,
  SessionSummary,
  SkillInfo,
  StatusLineState,
} from '@shared/claude';
import { matchesQuery } from './model';

export type SectionId =
  | 'overview'
  | 'sessions'
  | 'usage'
  | 'gates'
  | 'memory'
  | 'skills'
  | 'agents'
  | 'plugins'
  | 'mcp'
  | 'hooks';

export type SectionIcon = 'overview' | 'chat' | 'gauge' | 'gate' | 'file' | 'skill' | 'agent' | 'plug' | 'mcp' | 'hook';

export interface SectionInfo {
  id: SectionId;
  label: string;
  /** Navigation group; the overview has none. */
  group: 'Activity' | 'Configuration' | null;
  icon: SectionIcon;
  /** One line under the section title that says what the section is. */
  blurb: string;
}

export const SECTIONS: readonly SectionInfo[] = [
  { id: 'overview', label: 'Overview', group: null, icon: 'overview', blurb: 'Your Claude Code setup for this project at a glance.' },
  { id: 'sessions', label: 'Sessions', group: 'Activity', icon: 'chat', blurb: 'Past conversations in this project. Resume one to pick up where you left off.' },
  { id: 'usage', label: 'Usage', group: 'Activity', icon: 'gauge', blurb: 'Plan limits, context fill and token counts.' },
  { id: 'gates', label: 'Gates', group: 'Activity', icon: 'gate', blurb: 'What scripts/gates.sh checks before you ship.' },
  { id: 'memory', label: 'CLAUDE.md', group: 'Configuration', icon: 'file', blurb: 'Instructions Claude reads at the start of every session.' },
  { id: 'skills', label: 'Skills', group: 'Configuration', icon: 'skill', blurb: 'Reusable instructions Claude loads when a task matches their description.' },
  { id: 'agents', label: 'Agents', group: 'Configuration', icon: 'agent', blurb: 'Specialised subagents Claude can hand work to, each with its own prompt and model.' },
  { id: 'plugins', label: 'Plugins', group: 'Configuration', icon: 'plug', blurb: 'Installed bundles of skills, agents, hooks and MCP servers.' },
  { id: 'mcp', label: 'MCP servers', group: 'Configuration', icon: 'mcp', blurb: 'External tools Claude can call, such as a browser, a database or GitHub.' },
  { id: 'hooks', label: 'Hooks', group: 'Configuration', icon: 'hook', blurb: 'Your commands that run automatically at moments like a tool call or the end of a turn.' },
];

export function sectionInfo(id: SectionId): SectionInfo {
  return SECTIONS.find((s) => s.id === id) ?? (SECTIONS[0] as SectionInfo);
}

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string' && SECTIONS.some((s) => s.id === value);
}

/** The viewer reads files only inside the project folder. */
export function isInsideProject(root: string, path: string): boolean {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return path.startsWith(`${base}/`);
}

/** Settings file a hook comes from, so the panel can show or open it. */
export function hookSettingsPath(scope: HookInfo['scope'], root: string, home: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  if (scope === 'user') return `${home}/.claude/settings.json`;
  return scope === 'local' ? `${base}/.claude/settings.local.json` : `${base}/.claude/settings.json`;
}

export function sessionTitle(session: Pick<SessionSummary, 'firstPrompt'>): string {
  return session.firstPrompt ?? 'Untitled session';
}

export interface SessionBucket {
  label: string;
  sessions: SessionSummary[];
}

/** Today, Yesterday, Earlier this week (last 7 days) and Older, by last activity in local time. */
export function sessionBuckets(sessions: readonly SessionSummary[], now: number): SessionBucket[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const yesterday = new Date(midnight);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(midnight);
  week.setDate(week.getDate() - 6);
  const buckets: SessionBucket[] = [
    { label: 'Today', sessions: [] },
    { label: 'Yesterday', sessions: [] },
    { label: 'Earlier this week', sessions: [] },
    { label: 'Older', sessions: [] },
  ];
  for (const session of sessions) {
    const at = Date.parse(session.lastActiveAt);
    const index = Number.isNaN(at) ? 3 : at >= today ? 0 : at >= yesterday.getTime() ? 1 : at >= week.getTime() ? 2 : 3;
    buckets[index]?.sessions.push(session);
  }
  return buckets.filter((b) => b.sessions.length > 0);
}

/** "in 45 min", "in 3 h", "in 2 d" until a reset time; "now" when it has passed. */
export function formatUntil(target: number, now: number): string {
  const minutes = Math.round((target - now) / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

/** Counts per scope, as "1 project · 2 user", in SCOPE order. */
export function scopeSummary(items: ReadonlyArray<{ scope: ConfigScope }>): string {
  const order: ConfigScope[] = ['project', 'local', 'user', 'plugin', 'claudeai'];
  const names: Record<ConfigScope, string> = { project: 'project', local: 'local', user: 'user', plugin: 'plugin', claudeai: 'claude.ai' };
  return order
    .map((scope) => [scope, items.filter((i) => i.scope === scope).length] as const)
    .filter(([, count]) => count > 0)
    .map(([scope, count]) => `${count} ${names[scope]}`)
    .join(' · ');
}

export interface McpHealth {
  total: number;
  connected: number;
  failed: number;
  needsAuth: number;
  disabled: number;
}

export function mcpHealth(servers: readonly McpServerInfo[]): McpHealth {
  const count = (state: McpServerInfo['state']): number => servers.filter((s) => s.state === state).length;
  return {
    total: servers.length,
    connected: count('connected'),
    failed: count('failed'),
    needsAuth: count('needs-auth'),
    disabled: count('disabled'),
  };
}

/** "1 failing · 2 connected" after a status check, leaving out zero counts. */
export function mcpSummaryText(health: McpHealth): string {
  if (health.failed + health.needsAuth === 0) {
    return health.connected === 1 ? 'The enabled server is connected' : `All ${health.connected} enabled servers connected`;
  }
  return [
    health.failed > 0 ? `${health.failed} failing` : null,
    health.needsAuth > 0 ? `${health.needsAuth} need${health.needsAuth === 1 ? 's' : ''} sign-in` : null,
    health.connected > 0 ? `${health.connected} connected` : null,
    health.disabled > 0 ? `${health.disabled} disabled` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type AttentionTone = 'error' | 'warn' | 'info';

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  detail: string;
  section: SectionId;
}

export interface AttentionInput {
  /** Servers with live status, or null while the status has not been checked. */
  mcpChecked: readonly McpServerInfo[] | null;
  memory: readonly MemoryFile[] | null;
  hooks: readonly HookInfo[] | null;
  statusLine: StatusLineState | null;
  /** Absolute path of the project's CLAUDE.md, to find it in `memory`. */
  projectClaudeMd: string;
}

/** Problems first (failing MCP servers), then things worth knowing (hooks that run, missing setup). */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const server of input.mcpChecked ?? []) {
    if (server.state === 'failed') {
      out.push({
        id: `mcp-failed-${server.name}`,
        tone: 'error',
        title: `MCP server "${server.name}" failed to connect`,
        detail: server.detail ?? 'Claude cannot use its tools until it starts.',
        section: 'mcp',
      });
    } else if (server.state === 'needs-auth') {
      out.push({
        id: `mcp-auth-${server.name}`,
        tone: 'warn',
        title: `MCP server "${server.name}" needs authentication`,
        detail: 'Run /mcp in Claude to sign in.',
        section: 'mcp',
      });
    }
  }
  const projectMd = input.memory?.find((f) => f.path === input.projectClaudeMd);
  if (projectMd && projectMd.content === null) {
    out.push({
      id: 'no-claude-md',
      tone: 'info',
      title: 'This project has no CLAUDE.md',
      detail: 'Run /init in Claude to create one with the project\'s commands and conventions.',
      section: 'memory',
    });
  }
  if (input.hooks && input.hooks.length > 0) {
    const events = [...new Set(input.hooks.map((h) => h.event))];
    const count = input.hooks.length;
    out.push({
      id: 'hooks',
      tone: 'info',
      title: `${count} ${count === 1 ? 'hook runs' : 'hooks run'} automatically`,
      detail: `On ${events.join(', ')}. They run your commands without asking.`,
      section: 'hooks',
    });
  }
  if (input.statusLine?.state === 'off') {
    out.push({
      id: 'status-line',
      tone: 'info',
      title: 'Plan usage is hidden',
      detail: 'Turn on the status line to see 5-hour and weekly limits here and in the header.',
      section: 'usage',
    });
  }
  return out;
}

export interface SearchData {
  skills: readonly SkillInfo[] | null;
  agents: readonly AgentInfo[] | null;
  plugins: readonly PluginInfo[] | null;
  mcp: readonly McpServerInfo[] | null;
  hooks: readonly HookInfo[] | null;
}

export interface SearchResults {
  skills: SkillInfo[];
  agents: AgentInfo[];
  plugins: PluginInfo[];
  mcp: McpServerInfo[];
  hooks: HookInfo[];
  total: number;
}

export const skillFields = (s: SkillInfo): (string | null)[] => [s.name, s.description, s.pluginName];
export const agentFields = (a: AgentInfo): (string | null)[] => [a.name, a.description, a.model];
export const pluginFields = (p: PluginInfo): (string | null)[] => [p.name, p.marketplace, p.id];
export const mcpFields = (m: McpServerInfo): (string | null)[] => [m.name, m.command, m.url, m.transport];
export const hookFields = (h: HookInfo): (string | null)[] => [h.event, h.matcher, h.command];

/** One query over every kind of config item, for the overview's search box. */
export function searchAll(data: SearchData, query: string): SearchResults {
  const pick = <T>(items: readonly T[] | null, fields: (item: T) => (string | null)[]): T[] =>
    (items ?? []).filter((item) => matchesQuery(fields(item), query));
  const skills = pick(data.skills, skillFields);
  const agents = pick(data.agents, agentFields);
  const plugins = pick(data.plugins, pluginFields);
  const mcp = pick(data.mcp, mcpFields);
  const hooks = pick(data.hooks, hookFields);
  return { skills, agents, plugins, mcp, hooks, total: skills.length + agents.length + plugins.length + mcp.length + hooks.length };
}
