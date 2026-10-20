/** Read-only views of Claude Code configuration and usage for one project. No Electron imports. */
import type { GateTarget } from './app';

export const ClaudeChannel = {
  Skills: 'claude:skills',
  Plugins: 'claude:plugins',
  Mcp: 'claude:mcp',
  McpConfigured: 'claude:mcpConfigured',
  ReadConfigFile: 'claude:readConfigFile',
  Usage: 'claude:usage',
  Agents: 'claude:agents',
  Hooks: 'claude:hooks',
  Memory: 'claude:memory',
  Sessions: 'claude:sessions',
  Gates: 'claude:gates',
  StatusLineState: 'claude:statusLineState',
  StatusLineEnable: 'claude:statusLineEnable',
  StatusLineDisable: 'claude:statusLineDisable',
  UsageLive: 'claude:usageLive',
  Subagents: 'claude:subagents',
  Feed: 'claude:feed',
  /** Event: a live usage record was written or removed. */
  UsageLiveEvent: 'claude:usageLiveEvent',
} as const;

/** Where a skill, plugin or MCP server is configured: the user's home, this project, or a plugin. */
export type ConfigScope = 'user' | 'project' | 'local' | 'plugin' | 'claudeai';

export interface SkillInfo {
  name: string;
  description: string | null;
  scope: ConfigScope;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** Plugin the skill came from, when scope is 'plugin'. */
  pluginName: string | null;
}

export interface PluginInfo {
  /** Full id as Claude Code writes it, e.g. `vercel@claude-plugins-official`. */
  id: string;
  name: string;
  marketplace: string;
  version: string | null;
  /** Enabled in the user's settings or in this project's settings. */
  enabled: boolean;
  scope: 'user' | 'project';
  installedAt: string | null;
  path: string | null;
}

export type McpState = 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'unknown';

export interface McpServerInfo {
  name: string;
  scope: ConfigScope;
  transport: string | null;
  command: string | null;
  url: string | null;
  state: McpState;
  /** Short reason or error text, when the state is not 'connected'. */
  detail: string | null;
}

export interface UsageWindow {
  label: string;
  /** Assistant messages counted in this window. */
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Distinct Claude sessions that had at least one message in this window. */
  sessions: number;
}

/** The newest plan limit that stopped a request in the last 7 days. */
export interface UsageLimit {
  state: 'hit' | 'none';
  /** ISO time of the rejected request, or null when none. */
  hitAt: string | null;
  /** ISO time when the limit resets, when Claude Code recorded it. */
  resetsAt: string | null;
  /** E.g. "five_hour" for the session limit. */
  rateLimitType: string | null;
}

export interface UsageSummary {
  /** Most recently active session of this project, or null when none has a transcript. */
  currentSession: UsageWindow | null;
  today: UsageWindow;
  last7Days: UsageWindow;
  limit: UsageLimit;
  /**
   * Plan limits are not stored on disk, so percentages of the weekly or session limit are not
   * available here. The figures are token counts from the transcripts.
   */
  limitsNote: string;
}

export interface AgentInfo {
  name: string;
  description: string | null;
  scope: ConfigScope;
  path: string;
  model: string | null;
}

export interface HookInfo {
  /** PreToolUse, PostToolUse, Stop, SessionEnd and so on. */
  event: string;
  matcher: string | null;
  command: string;
  scope: 'user' | 'project' | 'local';
}

export interface MemoryFile {
  /** Human label, e.g. "Project CLAUDE.md" or "Global CLAUDE.md". */
  label: string;
  path: string;
  /** Null when the file does not exist. */
  content: string | null;
}

export interface SessionSummary {
  sessionId: string;
  /**
   * Title Claude Code saved for the session: a name the user gave it (`/rename`), else the title
   * Claude Code generated, else an older summary record. Null when the transcript has none.
   */
  title: string | null;
  /** First real prompt the user typed, trimmed; null when the transcript has none. */
  firstPrompt: string | null;
  /** ISO time of the first entry, or null when the transcript has no timestamps. */
  startedAt: string | null;
  /** ISO time of the last write to the transcript. */
  lastActiveAt: string;
  /** User and assistant entries in the transcript. */
  messages: number;
}

/** One subagent (Agent tool run) of a Claude Code session, read from its transcript folder. */
export interface SubagentInfo {
  id: string;
  /** The Agent tool's description, when the meta file has one. */
  label: string | null;
  /** Agent type as spawned: fork, general-purpose, Explore, a custom agent name. */
  agentType: string | null;
  /** Model id of the latest assistant turn; null before the first turn. */
  model: string | null;
  modelName: string | null;
  startedAt: string | null;
  lastActivityAt: string;
  /** True until the transcript ends with a finished turn, or it went quiet for ten minutes. */
  running: boolean;
  /** tool_use id of the parent's Agent call that started it, from the meta file. */
  toolUseId: string | null;
}

/** One rate-limit window as reported by Claude Code's status line. */
export interface LiveUsageWindow {
  /** 0..100, rounded. */
  usedPercent: number | null;
  /** Unix milliseconds when the window resets. */
  resetsAt: number | null;
}

/**
 * Plan utilization of one Claude Code session, written by ARcode's status line script
 * (`resources/arcode-statusline.py`) on every status line update. Rate limits appear only for
 * claude.ai Pro/Max and only after the first API response of the session.
 */
export interface LiveUsage {
  sessionId: string;
  cwd: string | null;
  /** Model id from the status line input, e.g. `claude-opus-5-5`; updated right after `/model`. */
  modelId: string | null;
  modelName: string | null;
  /** Input tokens currently in the context window (the figure `contextPercent` is computed from). */
  contextUsed: number | null;
  /** Context window size in tokens, e.g. 200000. */
  contextSize: number | null;
  contextPercent: number | null;
  fiveHour: LiveUsageWindow | null;
  sevenDay: LiveUsageWindow | null;
  /** Unix milliseconds of the last write. */
  updatedAt: number;
}

/** Whether ~/.claude/settings.json points the status line at ARcode's script, elsewhere, or nowhere. */
export interface StatusLineState {
  state: 'off' | 'acode' | 'other';
  command: string | null;
}

/** Text of a skill, agent or CLAUDE.md file for the panel's inline preview. */
export type ConfigFileContent = { ok: true; text: string; truncated: boolean } | { ok: false; reason: string };

export type StatusLineResult = { ok: true } | { ok: false; reason: string };

export interface ClaudeApi {
  skills(root: string): Promise<SkillInfo[]>;
  plugins(root: string): Promise<PluginInfo[]>;
  /** Runs `claude mcp list` for the project; slow, so the UI should call it on demand. */
  mcp(root: string): Promise<McpServerInfo[]>;
  /** MCP servers from the settings files only (fast, no CLI run); every state is 'unknown' or 'disabled'. */
  mcpConfigured(root: string): Promise<McpServerInfo[]>;
  /**
   * Read-only preview of a Markdown, JSON or text file under `~/.claude` or the project, for files
   * the viewer cannot open because they are outside the project folder.
   */
  readConfigFile(root: string, path: string): Promise<ConfigFileContent>;
  usage(root: string): Promise<UsageSummary>;
  agents(root: string): Promise<AgentInfo[]>;
  hooks(root: string): Promise<HookInfo[]>;
  memory(root: string): Promise<MemoryFile[]>;
  /** Past sessions of this project, newest first, at most 200. */
  sessions(root: string): Promise<SessionSummary[]>;
  /** Gate commands and test coverage in plain words. Read-only. */
  gates(root: string): Promise<GatesOverview>;
  /** Subagents of a session, newest first; running ones first. */
  subagents(sessionId: string): Promise<SubagentInfo[]>;
  /** A byte range of a session transcript turned into feed items (see FeedRequest). */
  feed(request: FeedRequest): Promise<FeedChunk>;
  /** Status line wiring in the user's Claude settings. Changes happen only on explicit user action. */
  statusLineState(): Promise<StatusLineState>;
  statusLineEnable(): Promise<StatusLineResult>;
  statusLineDisable(): Promise<StatusLineResult>;
  /** Snapshot of live usage records of all sessions that reported through the status line. */
  usageLive(): Promise<LiveUsage[]>;
  onUsageLive(listener: (records: LiveUsage[]) => void): () => void;
}

export interface GateInfo {
  target: GateTarget;
  /** Commands the gate runs, in order, e.g. `pnpm run lint`. Empty when no script is configured. */
  commands: string[];
  /** Package scripts the gate needs that are missing from package.json. */
  missing: string[];
  explanation: string;
}

export interface CoverageArea {
  /** Human name of the area, in the language of the Gates view. */
  name: string;
  /** Project-relative folder, e.g. `src/main/files`. */
  folder: string;
  testFiles: number;
  /** Approximate: occurrences of `it(` and `test(` in the test files. */
  tests: number;
}

export interface GatesOverview {
  gates: GateInfo[];
  areas: CoverageArea[];
  /** Where the last gate result can be seen. */
  resultNote: string;
}

/**
 * The Claude feed: a readable view of one session transcript. Main reads byte ranges of the
 * JSON Lines file and turns records into these items; the renderer only merges and draws them.
 */
export type FeedItem = FeedItemBody & {
  id: string;
  /** ISO time of the record, when it has one. */
  at: string | null;
  /** Byte offset of the record's line in the transcript. */
  offset: number;
};

export type FeedItemBody =
  /**
   * A prompt the user typed (or queued while Claude was busy). `thumbs` holds data URLs of pasted
   * images small enough to send along; `images` counts all of them.
   */
  | { kind: 'user'; text: string; images: number; thumbs?: string[] }
  /** A slash command or a `!` shell command the user ran, e.g. `/model opus`. */
  | { kind: 'command'; text: string }
  /** Assistant text, Markdown. */
  | { kind: 'assistant'; text: string }
  /**
   * One tool call. `id` is the tool_use id, which the matching FeedToolResult carries. Known tools
   * come with a structured `detail`; for the rest `input` is the JSON input (truncated).
   */
  | { kind: 'tool'; name: string; summary: string; input: string; detail: FeedToolDetail | null }
  /**
   * A small muted line: an agent finished, the conversation was compacted, an interrupt. Notices
   * of background tasks (agents, background shells) name the tool call that started them.
   */
  | { kind: 'notice'; text: string; task?: FeedTaskNotice };

export interface FeedTaskNotice {
  /** tool_use id of the call that started the task, when the notification names it. */
  toolUseId: string | null;
  /** `completed`, `failed`, `killed`... as Claude Code wrote it. */
  status: string;
  /** Final report of the task (an agent's answer), truncated. */
  result: string | null;
}

export type FeedTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface FeedTodo {
  content: string;
  status: FeedTodoStatus;
  /** Present-tense form shown while the item is in progress ("Running tests"). */
  activeForm: string | null;
}

export interface FeedQuestion {
  question: string;
  /** Short chip label above the question. */
  header: string | null;
  multiSelect: boolean;
  options: { label: string; description: string | null }[];
}

/** Structured input of the tools the feed draws in their own way. Long strings are truncated. */
export type FeedToolDetail =
  | { type: 'bash'; command: string; description: string | null; background: boolean }
  /** Edit and MultiEdit: replaced and replacing text of each edit. */
  | { type: 'edit'; path: string; edits: { oldText: string; newText: string }[] }
  | { type: 'write'; path: string; content: string }
  | { type: 'read'; path: string; offset: number | null; limit: number | null }
  /** Grep and Glob. */
  | { type: 'search'; pattern: string; path: string | null; glob: string | null }
  | { type: 'agent'; agentType: string | null; description: string; prompt: string; model: string | null; background: boolean }
  | { type: 'todos'; todos: FeedTodo[] }
  /** TaskCreate and TaskUpdate of the task list tools. */
  | { type: 'task'; taskId: string | null; subject: string | null; status: string | null; activeForm: string | null }
  | { type: 'question'; questions: FeedQuestion[] }
  | { type: 'plan'; plan: string }
  | { type: 'web'; url: string | null; query: string | null; prompt: string | null };

/** One hunk of a file edit as Claude Code reports it: lines prefixed with ' ', '-' or '+'. */
export interface FeedHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** Output of a tool call; arrives in a later record than the call and may land in another chunk. */
export interface FeedToolResult {
  toolUseId: string;
  /** Truncated text of the result. */
  text: string;
  isError: boolean;
  /** Edits and writes: the applied patch with real line numbers (truncated). */
  patch?: FeedHunk[];
  /** Write: true when the file was created rather than overwritten. */
  created?: boolean;
  /** Grep and Glob: number of matching files, or of matching lines for Grep in content mode. */
  matches?: { count: number; unit: 'files' | 'lines' };
  /** Read: lines returned and the file's total line count. */
  lines?: { count: number; total: number | null };
  /** Agent: the launched agent, as far as the result tells. */
  agent?: { agentId: string | null; model: string | null; async: boolean };
  /** AskUserQuestion: the user's answer per question text. */
  answers?: Record<string, string>;
  /** ExitPlanMode: the approved plan as Claude Code reports it (the call's own input may be empty). */
  plan?: string;
}

/**
 * What to read. With `from`, the bytes appended after that offset (live updates); with `before`,
 * one chunk ending at that offset ("load earlier"); with neither, the tail of the file.
 */
export interface FeedRequest {
  sessionId: string;
  /**
   * Reads the transcript of this subagent of the session instead of the session's own one
   * (`<sessionId>/subagents/agent-<agentId>.jsonl`). Its records are all sidechain records.
   */
  agentId?: string;
  from?: number;
  before?: number;
}

export interface FeedChunk {
  /** False when the session has no transcript (yet). */
  found: boolean;
  /** File size when it was read. */
  size: number;
  /** Byte range of whole lines this chunk covers: [start, end). Continue live reads from `end`. */
  start: number;
  end: number;
  /**
   * True when `from` pointed past the end of the file (it was rewritten): the chunk is a fresh
   * tail and the renderer must drop what it has.
   */
  reset: boolean;
  items: FeedItem[];
  results: FeedToolResult[];
  /** Token usage of the assistant API calls in this range, one entry per transcript record. */
  usage: FeedUsage[];
  /**
   * Whether the last user or assistant record in this range ends a turn (end_turn, a hand-back
   * tool result, an interrupt); null when the range has none. Tells a finished subagent apart.
   */
  ended: boolean | null;
}

/**
 * Token usage of one assistant API call. Claude Code writes a streamed message once per content
 * block with the same message id; entries with the same `messageId` are one call (fields keep
 * their maximum).
 */
export interface FeedUsage {
  messageId: string;
  /** ISO time of the record. */
  at: string | null;
  /** Byte offset of the record's line in the transcript. */
  offset: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
