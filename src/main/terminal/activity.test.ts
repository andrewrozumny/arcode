import { describe, expect, it } from 'vitest';
import { ActivityMonitor, claudeShellCommand, parsePsTable, programName, ptyActivity } from './activity';

const BASH_TOOL =
  "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'pnpm test -- '\"'\"'a b'\"'\"'' < /dev/null && pwd -P >| /tmp/claude-1-cwd";

const TABLE = [
  '  100     1 /bin/zsh -l',
  '  101   100 claude --session-id abc',
  '  102   101 node /opt/mcp/server.js',
  '  103   101 caffeinate -i -t 300',
  `  104   101 ${BASH_TOOL}`,
  '  200     1 -zsh',
  '  201   200 pnpm dev',
  '  202   201 node vite',
  '  300     1 /bin/zsh -l',
].join('\n');

describe('parsePsTable', () => {
  it('reads pid, ppid and the full command', () => {
    const rows = parsePsTable(TABLE);
    expect(rows).toHaveLength(9);
    expect(rows[1]).toEqual({ pid: 101, ppid: 100, command: 'claude --session-id abc' });
  });

  it('skips lines that are not rows', () => {
    expect(parsePsTable('garbage\n\n  12 x')).toEqual([]);
  });
});

describe('programName', () => {
  it('strips the folder and the login dash', () => {
    expect(programName('/bin/zsh -c x')).toBe('zsh');
    expect(programName('-zsh')).toBe('zsh');
  });
});

describe('claudeShellCommand', () => {
  it('unwraps the command Claude Code evaluates', () => {
    expect(claudeShellCommand(BASH_TOOL)).toBe("pnpm test -- 'a b'");
  });

  it('turns escaped newlines of ps into spaces', () => {
    expect(claudeShellCommand("/bin/zsh -c x && eval 'cat <<EOF\\012hi\\012EOF' < /dev/null")).toBe('cat <<EOF hi EOF');
  });

  it('falls back to the -c argument', () => {
    expect(claudeShellCommand('/bin/bash -c sleep 30')).toBe('sleep 30');
  });
});

describe('ptyActivity', () => {
  const shells = new Map([
    [100, 1],
    [200, 2],
    [300, 3],
  ]);

  it('reports Claude Bash tool shells, shell children, and nothing for idle tabs', () => {
    expect(ptyActivity(parsePsTable(TABLE), shells)).toEqual([
      { ptyId: 1, jobs: [{ command: "pnpm test -- 'a b'", source: 'claude' }] },
      { ptyId: 2, jobs: [{ command: 'pnpm dev', source: 'shell' }] },
      { ptyId: 3, jobs: [] },
    ]);
  });

  it('ignores MCP servers and helpers of an idle Claude', () => {
    const rows = parsePsTable(TABLE).filter((r) => r.pid !== 104);
    expect(ptyActivity(rows, new Map([[100, 1]]))).toEqual([{ ptyId: 1, jobs: [] }]);
  });
});

describe('ActivityMonitor', () => {
  it('reports only changes', async () => {
    const seen: unknown[] = [];
    let table = TABLE;
    const monitor = new ActivityMonitor({
      shells: () => new Map([[200, 2]]),
      onChange: (a) => seen.push(a),
      read: () => Promise.resolve(parsePsTable(table)),
    });
    await monitor.tick();
    await monitor.tick();
    expect(seen).toHaveLength(1);
    table = table.replace('  201   200 pnpm dev', '');
    await monitor.tick();
    expect(seen).toHaveLength(2);
    expect(monitor.snapshot()).toEqual([{ ptyId: 2, jobs: [] }]);
  });
});
