/**
 * Environment for child processes spawned in terminals.
 *
 * Credentials and provider switches that would make Claude Code bill an API
 * key (or talk to another gateway) instead of the user's subscription are
 * removed on purpose, as are markers that make a nested claude believe it is
 * a child session.
 */

export const STRIPPED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'AWS_BEARER_TOKEN_BEDROCK',
];

/**
 * Markers a parent terminal or a parent Claude Code session leaves in the
 * environment when Acode itself is launched from one. Inherited by a nested
 * claude they make it believe it is a child session (e.g. transcripts off).
 */
export const INHERITED_SESSION_KEYS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'TERMINAL_EMULATOR',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
];

/** Every CLAUDE_CODE_* variable of a parent session is dropped; the bridge port is re-added via extra env. */
const INHERITED_SESSION_PREFIX = 'CLAUDE_CODE_';

export type Env = Record<string, string | undefined>;

export interface ChildEnvOptions {
  /** Project folder, exported as ACODE_PROJECT. */
  project?: string;
  /** Applied last, wins over everything (e.g. CLAUDE_CODE_SSE_PORT from the IDE bridge). */
  extraEnv?: Record<string, string> | undefined;
}

export function envForChild(source: Env = process.env, options: ChildEnvOptions = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV_KEYS.includes(key) || INHERITED_SESSION_KEYS.includes(key)) continue;
    if (key.startsWith(INHERITED_SESSION_PREFIX)) continue;
    result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  if (!result.LANG) result.LANG = 'en_US.UTF-8';
  result.ACODE = '1';
  result.TERM_PROGRAM = 'Acode';
  result.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';
  if (options.project) result.ACODE_PROJECT = options.project;
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) result[key] = value;
  }
  return result;
}
