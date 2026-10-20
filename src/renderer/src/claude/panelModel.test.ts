import { describe, expect, it } from 'vitest';
import type { HookInfo, McpServerInfo, MemoryFile, SessionSummary } from '@shared/claude';
import {
  attentionItems,
  formatUntil,
  hookSettingsPath,
  isInsideProject,
  isSectionId,
  mcpHealth,
  mcpSummaryText,
  scopeSummary,
  searchAll,
  sessionBuckets,
  sessionTitle,
  feedTabTitle,
  FEED_TAB_CHARS,
} from './panelModel';

const session = (id: string, lastActiveAt: string, firstPrompt: string | null = id): SessionSummary => ({
  sessionId: id,
  title: null,
  firstPrompt,
  startedAt: null,
  lastActiveAt,
  messages: 2,
});

const server = (name: string, state: McpServerInfo['state'], detail: string | null = null): McpServerInfo => ({
  name,
  scope: 'project',
  transport: 'stdio',
  command: 'npx x',
  url: null,
  state,
  detail,
});

const hook = (event: string, command: string): HookInfo => ({ event, matcher: null, command, scope: 'user' });

describe('sessionBuckets', () => {
  // Local noon on 21 Oct 2026 (a Wednesday).
  const now = new Date(2026, 9, 21, 12, 0).getTime();
  const at = (days: number, hour = 10): string => new Date(2026, 9, 21 - days, hour).toISOString();

  it('groups by local day and keeps the input order', () => {
    const buckets = sessionBuckets(
      [session('a', at(0, 11)), session('b', at(0, 1)), session('c', at(1, 23)), session('d', at(4)), session('e', at(9)), session('f', 'bad')],
      now,
    );
    expect(buckets.map((b) => [b.label, b.sessions.map((s) => s.sessionId)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Earlier this week', ['d']],
      ['Older', ['e', 'f']],
    ]);
  });

  it('leaves out empty buckets', () => {
    expect(sessionBuckets([session('e', at(30))], now).map((b) => b.label)).toEqual(['Older']);
    expect(sessionBuckets([], now)).toEqual([]);
  });
});

describe('small helpers', () => {
  it('formats time until a reset', () => {
    const now = 1_000_000_000;
    expect(formatUntil(now - 5, now)).toBe('now');
    expect(formatUntil(now + 45 * 60000, now)).toBe('in 45 min');
    expect(formatUntil(now + 3 * 3600000, now)).toBe('in 3 h');
    expect(formatUntil(now + 3 * 86400000, now)).toBe('in 3 d');
  });

  it('names sessions without a prompt', () => {
    expect(sessionTitle({ firstPrompt: null })).toBe('Untitled session');
    expect(sessionTitle({ firstPrompt: 'Fix it' })).toBe('Fix it');
    expect(sessionTitle({ firstPrompt: 'Fix it', title: 'Login bug' })).toBe('Login bug');
    expect(sessionTitle({ firstPrompt: null, title: null })).toBe('Untitled session');
  });

  it('cuts feed tab titles to fit a tab', () => {
    expect(feedTabTitle('Fix  the\nbug')).toBe('Fix the bug');
    expect(feedTabTitle('   ')).toBe('Untitled session');
    const long = feedTabTitle('word '.repeat(20));
    expect(long.length).toBe(FEED_TAB_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toContain(' …');
  });

  it('summarises scopes in a fixed order', () => {
    expect(scopeSummary([{ scope: 'user' }, { scope: 'project' }, { scope: 'user' }, { scope: 'plugin' }])).toBe('1 project · 2 user · 1 plugin');
    expect(scopeSummary([])).toBe('');
  });

  it('knows which files are inside the project', () => {
    expect(isInsideProject('/w/app', '/w/app/CLAUDE.md')).toBe(true);
    expect(isInsideProject('/w/app/', '/w/app/CLAUDE.md')).toBe(true);
    expect(isInsideProject('/w/app', '/w/apple/CLAUDE.md')).toBe(false);
  });

  it('maps hook scopes to their settings file', () => {
    expect(hookSettingsPath('user', '/w/app', '/Users/me')).toBe('/Users/me/.claude/settings.json');
    expect(hookSettingsPath('project', '/w/app/', '/Users/me')).toBe('/w/app/.claude/settings.json');
    expect(hookSettingsPath('local', '/w/app', '/Users/me')).toBe('/w/app/.claude/settings.local.json');
  });

  it('validates section ids', () => {
    expect(isSectionId('mcp')).toBe(true);
    expect(isSectionId('nope')).toBe(false);
    expect(isSectionId(3)).toBe(false);
  });

  it('counts MCP states', () => {
    expect(mcpHealth([server('a', 'connected'), server('b', 'failed'), server('c', 'needs-auth'), server('d', 'unknown')])).toEqual({
      total: 4,
      connected: 1,
      failed: 1,
      needsAuth: 1,
      disabled: 0,
    });
  });
});

describe('mcpSummaryText', () => {
  const health = (failed: number, needsAuth: number, connected: number, disabled = 0) => ({
    total: failed + needsAuth + connected + disabled,
    failed,
    needsAuth,
    connected,
    disabled,
  });

  it('leaves out zero counts', () => {
    expect(mcpSummaryText(health(1, 0, 2))).toBe('1 failing · 2 connected');
    expect(mcpSummaryText(health(0, 2, 0, 1))).toBe('2 need sign-in · 1 disabled');
  });

  it('says so when everything is connected', () => {
    expect(mcpSummaryText(health(0, 0, 3))).toBe('All 3 enabled servers connected');
    expect(mcpSummaryText(health(0, 0, 1))).toBe('The enabled server is connected');
  });
});

describe('attentionItems', () => {
  const memory = (content: string | null): MemoryFile[] => [{ label: 'Project CLAUDE.md', path: '/w/app/CLAUDE.md', content }];

  it('puts failing servers first and explains the rest', () => {
    const items = attentionItems({
      mcpChecked: [server('ok', 'connected'), server('db', 'failed', 'Failed to connect'), server('gh', 'needs-auth')],
      memory: memory(null),
      hooks: [hook('Stop', 'say done'), hook('PostToolUse', 'prettier'), hook('Stop', 'afplay')],
      statusLine: { state: 'off', command: null },
      projectClaudeMd: '/w/app/CLAUDE.md',
    });
    expect(items.map((i) => [i.tone, i.section])).toEqual([
      ['error', 'mcp'],
      ['warn', 'mcp'],
      ['info', 'memory'],
      ['info', 'hooks'],
      ['info', 'usage'],
    ]);
    expect(items[0]?.detail).toBe('Failed to connect');
    expect(items[3]?.title).toBe('3 hooks run automatically');
    expect(items[3]?.detail).toContain('Stop, PostToolUse');
  });

  it('is empty when everything is set up', () => {
    expect(
      attentionItems({
        mcpChecked: null,
        memory: memory('# App'),
        hooks: [],
        statusLine: { state: 'acode', command: null },
        projectClaudeMd: '/w/app/CLAUDE.md',
      }),
    ).toEqual([]);
  });
});

describe('searchAll', () => {
  it('searches every kind and totals the matches', () => {
    const results = searchAll(
      {
        skills: [{ name: 'release', description: 'Tag a release', scope: 'project', path: '/p', pluginName: null }],
        agents: [{ name: 'reviewer', description: 'Reviews release notes', scope: 'project', path: '/a', model: null }],
        plugins: null,
        mcp: [server('postgres', 'unknown')],
        hooks: [hook('Stop', 'notify release')],
      },
      'RELEASE',
    );
    expect([results.skills.length, results.agents.length, results.plugins.length, results.mcp.length, results.hooks.length]).toEqual([1, 1, 0, 0, 1]);
    expect(results.total).toBe(3);
  });
});
