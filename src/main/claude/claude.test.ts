import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './common';
import { projectDir, projectSlug } from './transcripts';
import { listAgents } from './agents';
import { listHooks } from './hooks';
import { listMemory } from './memory';
import { disabledMcpNames, mergeMcp, parseMcpList } from './mcp';
import { enabledFor, listPlugins } from './plugins';
import { listSkills } from './skills';
import { summarizeUsage } from './usage';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'acode-claude-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

const ROOT = '/work/app';

describe('parseFrontmatter', () => {
  it('reads flat keys and strips quotes', () => {
    const text = '---\nname: "review"\ndescription: \'Checks code\'\nmodel: opus\n---\nbody: not read';
    expect(parseFrontmatter(text)).toEqual({ name: 'review', description: 'Checks code', model: 'opus' });
  });

  it('returns nothing without a frontmatter block', () => {
    expect(parseFrontmatter('# Title\nname: x')).toEqual({});
  });
});

describe('projectSlug', () => {
  it('turns slashes and dots into dashes', () => {
    expect(projectSlug('/Users/me/code/acode')).toBe('-Users-me-code-acode');
    expect(projectSlug('/Users/me/.app')).toBe('-Users-me--app');
  });

  it('turns every non-alphanumeric character into a dash, like Claude Code does', () => {
    expect(projectSlug('/Users/me/My Project')).toBe('-Users-me-My-Project');
    expect(projectSlug('/Users/me/my_app (copy)')).toBe('-Users-me-my-app--copy-');
    expect(projectSlug('/Users/me/проект')).toBe('-Users-me-------');
  });

  it('finds the hashed folder Claude Code uses for very long paths', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-slug-'));
    const root = `/Users/me/${'deep/'.repeat(45)}project`;
    const long = projectSlug(root);
    expect(long.length).toBeGreaterThan(200);
    mkdirSync(join(home, '.claude', 'projects', `${long.slice(0, 200)}-abc123`), { recursive: true });
    expect(await projectDir(root, home)).toBe(join(home, '.claude', 'projects', `${long.slice(0, 200)}-abc123`));
    expect(await projectDir('/Users/me/short', home)).toBe(join(home, '.claude', 'projects', '-Users-me-short'));
  });
});

describe('listSkills', () => {
  it('lists skills whose folder is a symlink', () => {
    const home = tree({ 'store/linked/SKILL.md': '---\nname: linked\n---\n', '.claude/skills/.keep': '' });
    symlinkSync(join(home, 'store', 'linked'), join(home, '.claude', 'skills', 'linked'));
    const root = mkdtempSync(join(os.tmpdir(), 'acode-skill-root-'));
    expect(listSkills(root, home).map((s) => s.name)).toContain('linked');
  });

  it('finds user, project and plugin skills and falls back to the folder name', () => {
    const home = tree({
      '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship it\n---\n',
      '.claude/skills/bare/SKILL.md': '# no frontmatter\n',
      '.claude/skills/empty/README.md': 'not a skill',
      '.claude/plugins/installed_plugins.json': JSON.stringify({
        version: 2,
        plugins: {
          'vercel@official': [{ scope: 'user', installPath: '' }],
        },
      }),
    });
    const root = tree({ '.claude/skills/local/SKILL.md': '---\ndescription: "Project only"\n---\n' });
    const pluginPath = tree({ 'skills/zap/SKILL.md': '---\nname: zap\n---\n' });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'vercel@official': [{ scope: 'user', installPath: pluginPath }] } }),
    );
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'vercel@official': [{ scope: 'user', installPath: pluginPath }] } }),
    );

    const skills = listSkills(root, home);
    const byName = Object.fromEntries(skills.map((s) => [`${s.scope}:${s.name}`, s]));
    expect(byName['user:deploy']?.description).toBe('Ship it');
    expect(byName['user:bare']?.description).toBeNull();
    expect(byName['project:local']?.description).toBe('Project only');
    expect(byName['plugin:zap']?.pluginName).toBe('vercel');
    expect(skills.some((s) => s.name === 'empty')).toBe(false);
  });
});

describe('listPlugins', () => {
  it('resolves enablement with local over project over user', () => {
    const home = tree({
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': true, 'c@m': false } }),
    });
    const root = tree({
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'b@m': false } }),
      '.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'a@m': false, 'c@m': true } }),
    });
    expect(enabledFor(root, home, 'a@m')).toBe(false);
    expect(enabledFor(root, home, 'b@m')).toBe(false);
    expect(enabledFor(root, home, 'c@m')).toBe(true);
    expect(enabledFor(root, home, 'missing@m')).toBe(false);
  });

  it('lists installed plugins with the project install taking precedence', () => {
    const home = tree({
      '.claude/plugins/installed_plugins.json': JSON.stringify({
        version: 2,
        plugins: {
          'vercel@official': [
            { scope: 'user', installPath: '/cache/vercel/0.50', version: '0.50.0' },
            { scope: 'project', projectPath: ROOT, installPath: '/cache/vercel/0.51', version: '0.51.0' },
            { scope: 'project', projectPath: '/other', installPath: '/cache/other', version: '9' },
          ],
        },
      }),
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'vercel@official': true } }),
    });
    const [plugin] = listPlugins(ROOT, home);
    expect(plugin).toMatchObject({ id: 'vercel@official', name: 'vercel', marketplace: 'official', version: '0.51.0', scope: 'project', enabled: true });
  });
});

describe('listAgents and listHooks', () => {
  it('reads agents from user and project folders', () => {
    const home = tree({ '.claude/agents/reviewer.md': '---\nname: reviewer\nmodel: sonnet\n---\n' });
    const root = tree({ '.claude/agents/helper.md': '---\ndescription: Helps\n---\n' });
    const agents = listAgents(root, home);
    expect(agents.map((a) => [a.name, a.scope, a.model])).toEqual([
      ['reviewer', 'user', 'sonnet'],
      ['helper', 'project', null],
    ]);
  });

  it('flattens event, matcher and command hooks from every settings file', () => {
    const home = tree({
      '.claude/settings.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
      }),
    });
    const root = tree({
      '.claude/settings.json': JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }, { type: 'prompt', prompt: 'x' }] },
          ],
        },
      }),
      '.claude/settings.local.json': JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'log' }] }] } }),
    });
    expect(listHooks(root, home)).toEqual([
      { event: 'Stop', matcher: null, command: 'notify', scope: 'user' },
      { event: 'PreToolUse', matcher: 'Bash', command: 'guard', scope: 'project' },
      { event: 'SessionEnd', matcher: null, command: 'log', scope: 'local' },
    ]);
  });
});

describe('listMemory', () => {
  it('returns the three CLAUDE.md files with null content when missing', () => {
    const home = tree({ '.claude/CLAUDE.md': 'global rules' });
    const root = tree({ 'CLAUDE.md': 'project rules' });
    expect(listMemory(root, home).map((m) => [m.label, m.content])).toEqual([
      ['Global CLAUDE.md', 'global rules'],
      ['Project CLAUDE.md', 'project rules'],
      ['Local CLAUDE.local.md', null],
    ]);
  });
});

describe('parseMcpList', () => {
  // Captured from `claude mcp list` in the project folder; the banner and SDK log lines are skipped.
  const sample = [
    'Checking MCP server health…',
    '[mcp-sdk] SEP-2352: stored OAuth credential has no \'issuer\' stamp (pre-upgrade storage).',
    'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
    'plugin:vercel:vercel: https://mcp.vercel.com (HTTP) - ! Needs authentication',
    'plugin:prisma:Prisma-Local: npx -y prisma mcp - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed',
    'notes: /x/tsx /x/apps/mcp/src/index.ts - ✔ Connected',
  ].join('\n');

  it('maps each status symbol to a state', () => {
    expect(parseMcpList(sample)).toEqual([
      { name: 'claude.ai Gmail', target: 'https://gmailmcp.googleapis.com/mcp/v1', state: 'connected', detail: null },
      { name: 'plugin:vercel:vercel', target: 'https://mcp.vercel.com (HTTP)', state: 'needs-auth', detail: null },
      {
        name: 'plugin:prisma:Prisma-Local',
        target: 'npx -y prisma mcp',
        state: 'failed',
        detail: 'Failed to connect — CONNECTION_CLOSED: Connection closed',
      },
      { name: 'notes', target: '/x/tsx /x/apps/mcp/src/index.ts', state: 'connected', detail: null },
    ]);
  });

  it('merges definitions with live state and marks disabled servers', () => {
    const merged = mergeMcp(
      [
        { name: 'notes', scope: 'user', transport: 'stdio', command: 'tsx x', url: null },
        { name: 'figma', scope: 'project', transport: 'http', command: null, url: 'https://f' },
      ],
      parseMcpList(sample),
      new Set(['figma']),
    );
    const byName = Object.fromEntries(merged.map((m) => [m.name, m]));
    expect(byName.notes).toMatchObject({ scope: 'user', state: 'connected', command: 'tsx x' });
    expect(byName.figma).toMatchObject({ scope: 'project', state: 'disabled', url: 'https://f' });
    expect(byName['claude.ai Gmail']).toMatchObject({ scope: 'claudeai', state: 'connected', url: 'https://gmailmcp.googleapis.com/mcp/v1' });
    expect(byName['plugin:vercel:vercel']).toMatchObject({ scope: 'plugin', state: 'needs-auth', detail: 'Needs authentication' });
  });

  it('reports unknown state when the CLI could not run', () => {
    const merged = mergeMcp([{ name: 'x', scope: 'project', transport: 'stdio', command: 'y', url: null }], null, new Set());
    expect(merged).toEqual([
      {
        name: 'x',
        scope: 'project',
        transport: 'stdio',
        command: 'y',
        url: null,
        state: 'unknown',
        detail: 'claude CLI not found or status check failed',
      },
    ]);
  });

  it('collects disabled names from settings and ~/.claude.json', () => {
    const root = tree({ '.claude/settings.local.json': JSON.stringify({ disabledMcpServers: ['b'] }) });
    const home = tree({ '.claude.json': JSON.stringify({ projects: { [root]: { disabledMcpjsonServers: ['a'] } } }) });
    expect([...disabledMcpNames(root, home)].sort()).toEqual(['a', 'b']);
  });
});

describe('summarizeUsage', () => {
  it('sums turns once per message id and splits them into windows', async () => {
    const home = os.tmpdir();
    const now = new Date(2026, 9, 9, 12, 0, 0);
    const root = `/work/usage-${Date.now()}`;
    const dir = join(home, '.claude', 'projects', projectSlug(root));
    mkdirSync(dir, { recursive: true });
    const line = (id: string, ts: string, output: number, input = 10): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
          id,
          usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
        },
      });
    const todayTs = new Date(2026, 9, 9, 8, 0, 0).toISOString();
    const earlierTs = new Date(2026, 9, 3, 8, 0, 0).toISOString();
    const oldTs = new Date(2026, 8, 1, 8, 0, 0).toISOString();
    // Streamed turn: same id twice with growing output; the larger value must win once.
    writeFileSync(
      join(dir, 'new.jsonl'),
      [line('m1', todayTs, 20), line('m1', todayTs, 50), line('m2', todayTs, 7), '{ broken'].join('\n') + '\n',
    );
    writeFileSync(join(dir, 'older.jsonl'), line('m3', earlierTs, 30) + '\n' + line('m4', oldTs, 999) + '\n');
    const recent = new Date(2026, 9, 9, 11, 0, 0);
    utimesSync(join(dir, 'new.jsonl'), recent, recent);
    utimesSync(join(dir, 'older.jsonl'), new Date(2026, 9, 4), new Date(2026, 9, 4));

    const usage = await summarizeUsage(root, home, now);
    expect(usage.currentSession).toMatchObject({ label: 'Current session', messages: 2, outputTokens: 57, inputTokens: 20 });
    expect(usage.today).toMatchObject({ messages: 2, outputTokens: 57, sessions: 1 });
    // The Oct 3 turn is inside the seven-day window; the Sep 1 turn is not.
    expect(usage.last7Days).toMatchObject({ messages: 3, outputTokens: 87, sessions: 2 });
    expect(usage.limitsNote).toContain('Plan percentages are not stored on disk');
  });

  it('reports the newest rejected limit and keeps limit records out of the counts', async () => {
    const home = os.tmpdir();
    const now = new Date(2026, 9, 9, 12, 0, 0);
    const root = `/work/limit-${Date.now()}`;
    const dir = join(home, '.claude', 'projects', projectSlug(root));
    mkdirSync(dir, { recursive: true });
    const turn = (id: string, ts: Date): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts.toISOString(),
        message: { id, usage: { input_tokens: 1, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      });
    const hit = (ts: Date, resetsAt: number): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts.toISOString(),
        error: 'rate_limit',
        message: {
          model: '<synthetic>',
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        quotaLimits: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
      });
    const resetsAt = Math.floor(new Date(2026, 9, 9, 15, 20, 0).getTime() / 1000);
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turn('a1', new Date(2026, 9, 9, 9, 0, 0)),
        hit(new Date(2026, 9, 5, 9, 0, 0), resetsAt - 3600),
        hit(new Date(2026, 9, 9, 10, 0, 0), resetsAt),
      ].join('\n') + '\n',
    );
    utimesSync(join(dir, 'session.jsonl'), new Date(2026, 9, 9, 10, 0, 0), new Date(2026, 9, 9, 10, 0, 0));

    const usage = await summarizeUsage(root, home, now);
    expect(usage.limit).toEqual({
      state: 'hit',
      hitAt: new Date(2026, 9, 9, 10, 0, 0).toISOString(),
      resetsAt: new Date(resetsAt * 1000).toISOString(),
      rateLimitType: 'five_hour',
    });
    expect(usage.last7Days).toMatchObject({ messages: 1, outputTokens: 4 });
  });

  it('reports no limit when no rejected request is in the last seven days', async () => {
    const usage = await summarizeUsage(`/work/none-${Date.now()}`, os.tmpdir(), new Date());
    expect(usage.limit).toEqual({ state: 'none', hitAt: null, resetsAt: null, rateLimitType: null });
  });

  it('returns no current session when the project has no transcripts', async () => {
    const usage = await summarizeUsage(`/work/none-${Date.now()}`, os.tmpdir(), new Date());
    expect(usage.currentSession).toBeNull();
    expect(usage.today.messages).toBe(0);
  });
});
