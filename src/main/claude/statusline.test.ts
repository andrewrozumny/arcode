import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acodeStatusLineEntry,
  disableStatusLine,
  enableStatusLine,
  statusLineStateOf,
  withAcodeStatusLine,
  withoutAcodeStatusLine,
} from './statusline';
import type { StatusLinePaths } from './statusline';
import { parseUsageRecord, readUsageDir } from './usageLive';

const SCRIPT = '/Users/me/Library/Application Support/Acode/acode-statusline.py';
const OURS = acodeStatusLineEntry(SCRIPT);

describe('statusLineStateOf', () => {
  it('reports off, acode and other', () => {
    expect(statusLineStateOf(null, SCRIPT)).toEqual({ state: 'off', command: null });
    expect(statusLineStateOf({ model: 'opus' }, SCRIPT)).toEqual({ state: 'off', command: null });
    expect(statusLineStateOf({ statusLine: OURS }, SCRIPT)).toEqual({ state: 'acode', command: OURS.command });
    expect(statusLineStateOf({ statusLine: { type: 'command', command: 'ccusage statusline' } }, SCRIPT)).toEqual({
      state: 'other',
      command: 'ccusage statusline',
    });
  });
});

describe('a user command that merely calls our script', () => {
  it('counts as foreign and is never removed', () => {
    const wrapped = { statusLine: { type: 'command', command: `bash -c 'python3 "${SCRIPT}"; ~/bin/git-prompt'` } };
    expect(statusLineStateOf(wrapped, SCRIPT).state).toBe('other');
    expect(withoutAcodeStatusLine(wrapped, SCRIPT)).toEqual(wrapped);
    expect(withAcodeStatusLine(wrapped, SCRIPT)).toBeNull();
  });
});

describe('withAcodeStatusLine / withoutAcodeStatusLine', () => {
  it('adds our entry and keeps every other key', () => {
    const next = withAcodeStatusLine({ model: 'opus', hooks: { Stop: [] } }, SCRIPT);
    expect(next).toEqual({ model: 'opus', hooks: { Stop: [] }, statusLine: OURS });
  });

  it('refuses to replace a foreign status line', () => {
    expect(withAcodeStatusLine({ statusLine: { type: 'command', command: 'other' } }, SCRIPT)).toBeNull();
  });

  it('removes only our own entry', () => {
    expect(withoutAcodeStatusLine({ model: 'opus', statusLine: OURS }, SCRIPT)).toEqual({ model: 'opus' });
    const foreign = { statusLine: { type: 'command', command: 'other' } };
    expect(withoutAcodeStatusLine(foreign, SCRIPT)).toEqual(foreign);
  });
});

function tempPaths(): StatusLinePaths & { home: string } {
  const home = mkdtempSync(join(os.tmpdir(), 'acode-sl-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return {
    home,
    source: resolve('resources/acode-statusline.py'),
    installed: join(home, 'Library', 'Application Support', 'Acode', 'acode-statusline.py'),
    settings: join(home, '.claude', 'settings.json'),
  };
}

describe('enableStatusLine / disableStatusLine (temp home)', () => {
  it('installs the script, writes the entry with a backup, and removes it again', () => {
    const paths = tempPaths();
    writeFileSync(paths.settings, JSON.stringify({ model: 'opus' }, null, 2));
    expect(enableStatusLine(paths)).toEqual({ ok: true });
    expect(existsSync(paths.installed)).toBe(true);
    const written = JSON.parse(readFileSync(paths.settings, 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({ model: 'opus', statusLine: acodeStatusLineEntry(paths.installed) });
    expect(readdirSync(join(paths.home, '.claude')).some((n) => n.startsWith('settings.json.bak-acode-'))).toBe(true);

    expect(disableStatusLine(paths)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(paths.settings, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('leaves a foreign status line untouched', () => {
    const paths = tempPaths();
    const original = JSON.stringify({ statusLine: { type: 'command', command: 'other' } }, null, 2);
    writeFileSync(paths.settings, original);
    const result = enableStatusLine(paths);
    expect(result.ok).toBe(false);
    expect(readFileSync(paths.settings, 'utf8')).toBe(original);
  });

  it('writes atomically: no temp file left, file mode kept', () => {
    const paths = tempPaths();
    writeFileSync(paths.settings, '{}');
    chmodSync(paths.settings, 0o600);
    expect(enableStatusLine(paths)).toEqual({ ok: true });
    expect(statSync(paths.settings).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(paths.home, '.claude')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps a symlinked settings.json a link and updates its target', () => {
    const paths = tempPaths();
    const real = join(paths.home, 'dotfiles-settings.json');
    writeFileSync(real, JSON.stringify({ model: 'opus' }));
    symlinkSync(real, paths.settings);
    expect(enableStatusLine(paths)).toEqual({ ok: true });
    expect(lstatSync(paths.settings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ model: 'opus', statusLine: acodeStatusLineEntry(paths.installed) });
  });

  it('creates settings.json when there is none', () => {
    const paths = tempPaths();
    expect(enableStatusLine(paths)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(paths.settings, 'utf8'))).toEqual({ statusLine: acodeStatusLineEntry(paths.installed) });
  });
});

describe('parseUsageRecord', () => {
  it('maps the script output to LiveUsage', () => {
    const record = parseUsageRecord(
      JSON.stringify({
        sessionId: 's1',
        cwd: '/work/app',
        model: { id: 'claude-fable-5-1', displayName: 'Fable 5.1' },
        contextWindow: { usedPercent: 43, size: 200000, totalInputTokens: 86000 },
        rateLimits: { fiveHour: { usedPercent: 12, resetsAt: 1738425600000 }, sevenDay: null },
        updatedAt: 5,
      }),
    );
    expect(record).toEqual({
      sessionId: 's1',
      cwd: '/work/app',
      modelId: 'claude-fable-5-1',
      modelName: 'Fable 5.1',
      contextUsed: 86000,
      contextSize: 200000,
      contextPercent: 43,
      fiveHour: { usedPercent: 12, resetsAt: 1738425600000 },
      sevenDay: null,
      updatedAt: 5,
    });
  });

  it('rejects garbage and records without a session id', () => {
    expect(parseUsageRecord('nope')).toBeNull();
    expect(parseUsageRecord('{"cwd":"/x"}')).toBeNull();
  });
});

const hasPython = ((): boolean => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPython)('acode-statusline.py', () => {
  it('prints one status line and writes the usage record under HOME', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-py-'));
    const input = JSON.stringify({
      session_id: 'abc',
      cwd: '/work/app',
      model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
      context_window: { used_percentage: 43.4, context_window_size: 200000, total_input_tokens: 86800 },
      cost: { total_cost_usd: 1.5 },
      rate_limits: { five_hour: { used_percentage: 12.4, resets_at: 1738425600 }, seven_day: { used_percentage: 37, resets_at: 1738857600 } },
    });
    const out = execFileSync('python3', [resolve('resources/acode-statusline.py')], { input, env: { ...process.env, HOME: home } }).toString();
    expect(out.trim()).toBe('Fable 5.1 · ctx 43% · 5h 12% · week 37%');
    const dir = join(home, 'Library', 'Application Support', 'Acode', 'usage');
    const [record] = await readUsageDir(dir);
    expect(record?.sessionId).toBe('abc');
    expect(record?.contextUsed).toBe(86800);
    expect(record?.contextSize).toBe(200000);
    expect(record?.fiveHour).toEqual({ usedPercent: 12, resetsAt: 1738425600000 });
    expect(record?.sevenDay?.usedPercent).toBe(37);
  });

  it('adds one line per running subagent with its model', () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-py-'));
    const projects = join(home, 'projects', '-work-app');
    const agents = join(projects, 'sess-1', 'subagents');
    mkdirSync(agents, { recursive: true });
    const assistant = (model: string, stop: string | null): string =>
      JSON.stringify({ type: 'assistant', message: { model, stop_reason: stop } });
    writeFileSync(join(agents, 'agent-run.jsonl'), assistant('claude-opus-5-5', 'tool_use') + '\n');
    writeFileSync(
      join(agents, 'agent-run.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', description: 'Patching scan loop', model: 'inherit' }),
    );
    writeFileSync(join(agents, 'agent-done.jsonl'), assistant('claude-haiku-5-5', 'end_turn') + '\n');
    writeFileSync(join(agents, 'agent-done.meta.json'), JSON.stringify({ agentType: 'Explore', model: 'inherit' }));
    const input = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: join(projects, 'sess-1.jsonl'),
      model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
    });
    const out = execFileSync('python3', [resolve('resources/acode-statusline.py')], { input, env: { ...process.env, HOME: home } }).toString();
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Fable 5.1');
    expect(lines[1]).toBe('  \u2937 general-purpose \u00b7 Opus 5.5 \u00b7 Patching scan loop \u00b7 0m');
  });

  it('never fails on bad input', () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-py-'));
    const out = execFileSync('python3', [resolve('resources/acode-statusline.py')], { input: 'not json', env: { ...process.env, HOME: home } }).toString();
    expect(out).toBe('\n');
  });
});
