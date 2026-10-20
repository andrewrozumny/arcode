import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_PREVIEW_BYTES, configFileAllowed, readConfigFile } from './configFile';

const HOME = '/Users/me';
const ROOT = '/work/app';

describe('configFileAllowed', () => {
  it('allows Markdown and JSON under ~/.claude and the project', () => {
    expect(configFileAllowed('/Users/me/.claude/skills/review/SKILL.md', ROOT, HOME)).toBe(true);
    expect(configFileAllowed('/Users/me/.claude/CLAUDE.md', ROOT, HOME)).toBe(true);
    expect(configFileAllowed('/work/app/.claude/agents/reviewer.md', ROOT, HOME)).toBe(true);
    expect(configFileAllowed('/work/app/.mcp.json', ROOT, HOME)).toBe(true);
  });

  it('refuses other folders, other file types and unnormalised paths', () => {
    expect(configFileAllowed('/Users/me/.ssh/config.md', ROOT, HOME)).toBe(false);
    expect(configFileAllowed('/Users/me/.claude.json', ROOT, HOME)).toBe(false);
    expect(configFileAllowed('/Users/me/.claude/../.ssh/id.md', ROOT, HOME)).toBe(false);
    expect(configFileAllowed('/Users/me/.claude/bin/tool', ROOT, HOME)).toBe(false);
    expect(configFileAllowed('/work/app-other/README.md', ROOT, HOME)).toBe(false);
    expect(configFileAllowed('.claude/CLAUDE.md', ROOT, HOME)).toBe(false);
    expect(configFileAllowed('/Users/me/.claude/.credentials.json', ROOT, HOME)).toBe(false);
  });
});

describe('readConfigFile', () => {
  const home = mkdtempSync(join(os.tmpdir(), 'acode-config-'));
  const root = mkdtempSync(join(os.tmpdir(), 'acode-config-root-'));
  mkdirSync(join(home, '.claude', 'skills', 'big'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Notes\n');
  writeFileSync(join(home, '.claude', 'skills', 'big', 'SKILL.md'), 'x'.repeat(CONFIG_PREVIEW_BYTES + 10));

  it('reads an allowed file', async () => {
    expect(await readConfigFile(root, join(home, '.claude', 'CLAUDE.md'), home)).toEqual({
      ok: true,
      text: '# Notes\n',
      truncated: false,
    });
  });

  it('cuts large files', async () => {
    const result = await readConfigFile(root, join(home, '.claude', 'skills', 'big', 'SKILL.md'), home);
    expect(result.ok && result.text.length === CONFIG_PREVIEW_BYTES && result.truncated).toBe(true);
  });

  it('reports missing and refused files without throwing', async () => {
    expect((await readConfigFile(root, join(home, '.claude', 'missing.md'), home)).ok).toBe(false);
    expect((await readConfigFile(root, '/etc/hosts', home)).ok).toBe(false);
  });
});
