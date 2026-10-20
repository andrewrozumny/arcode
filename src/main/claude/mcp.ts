import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConfigScope, McpServerInfo, McpState } from '@shared/claude';
import { isRecord, readJson, settingsFiles, stringOrNull } from './common';

/** Candidate locations of the claude CLI; the app's PATH may not include ~/.local/bin. */
function claudeCandidates(home: string): string[] {
  return ['claude', join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}

export interface McpStatusLine {
  name: string;
  target: string;
  state: McpState;
  detail: string | null;
}

/**
 * Parses `claude mcp list` output. Each server line looks like
 * `name: <command or url> - <status>`, where status starts with ✔ (connected), ! (needs authentication)
 * or ✘ (failed). Other lines (health-check banners, SDK logs) are skipped.
 */
export function parseMcpList(text: string): McpStatusLine[] {
  const out: McpStatusLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sep = line.lastIndexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep);
    const status = line.slice(sep + 3).trim();
    const colon = left.indexOf(': ');
    if (colon <= 0) continue;
    const name = left.slice(0, colon).trim();
    const target = left.slice(colon + 2).trim();
    const symbol = status.charAt(0);
    let state: McpState;
    let detail: string | null = null;
    if (symbol === '✔' || symbol === '✓') {
      state = 'connected';
    } else if (symbol === '!' && /needs authentication/i.test(status)) {
      state = 'needs-auth';
    } else if (symbol === '✘' || symbol === '✗') {
      state = 'failed';
      detail = status.replace(/^[✘✗]\s*/, '') || null;
    } else {
      continue;
    }
    out.push({ name, target, state, detail });
  }
  return out;
}

/** Runs `claude mcp list` in the project; resolves to null when no candidate binary runs. */
export function runMcpList(root: string, home: string = homedir()): Promise<string | null> {
  const candidates = claudeCandidates(home).filter((c) => !c.includes('/') || existsSync(c));
  const attempt = (index: number): Promise<string | null> => {
    const binary = candidates[index];
    if (binary === undefined) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(binary, ['mcp', 'list'], { cwd: root, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout) {
          // Not found on PATH (ENOENT) or failed: try the next candidate.
          resolve(attempt(index + 1));
          return;
        }
        resolve(`${stdout}\n${stderr}`);
      });
    });
  };
  return attempt(0);
}

interface Definition {
  name: string;
  scope: ConfigScope;
  transport: string | null;
  command: string | null;
  url: string | null;
}

function definitionsIn(servers: unknown, scope: ConfigScope): Definition[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).flatMap(([name, raw]) => {
    if (!isRecord(raw)) return [];
    const url = stringOrNull(raw.url);
    const command = stringOrNull(raw.command);
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
    return [
      {
        name,
        scope,
        transport: stringOrNull(raw.type) ?? (command ? 'stdio' : url ? 'http' : null),
        command: command ? [command, ...args].join(' ') : null,
        url,
      },
    ];
  });
}

/** Server definitions: user-wide, per-project (~/.claude.json) and the project's .mcp.json. */
export function listMcpDefinitions(root: string, home: string): Definition[] {
  const claudeJson = readJson(join(home, '.claude.json'));
  const projects = isRecord(claudeJson) && isRecord(claudeJson.projects) ? claudeJson.projects : {};
  const project = isRecord(projects[root]) ? projects[root] : {};
  const projectJson = readJson(join(root, '.mcp.json'));
  return [
    ...definitionsIn(isRecord(claudeJson) ? claudeJson.mcpServers : undefined, 'user'),
    ...definitionsIn(project.mcpServers, 'local'),
    ...definitionsIn(isRecord(projectJson) ? projectJson.mcpServers : undefined, 'project'),
  ];
}

/** Names disabled for this project in any applicable settings file or in ~/.claude.json. */
export function disabledMcpNames(root: string, home: string): Set<string> {
  const out = new Set<string>();
  const sources: unknown[] = settingsFiles(root, home).map(({ file }) => readJson(file));
  const claudeJson = readJson(join(home, '.claude.json'));
  if (isRecord(claudeJson) && isRecord(claudeJson.projects) && isRecord(claudeJson.projects[root])) {
    sources.push(claudeJson.projects[root]);
  }
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const key of ['disabledMcpjsonServers', 'disabledMcpServers']) {
      const list = source[key];
      if (Array.isArray(list)) for (const name of list) if (typeof name === 'string') out.add(name);
    }
  }
  return out;
}

/** Merges definitions with the live status from `claude mcp list`. */
export function mergeMcp(definitions: Definition[], statuses: McpStatusLine[] | null, disabled: Set<string>): McpServerInfo[] {
  const byName = new Map<string, McpServerInfo>();
  for (const d of definitions) {
    byName.set(d.name, {
      name: d.name,
      scope: d.scope,
      transport: d.transport,
      command: d.command,
      url: d.url,
      state: disabled.has(d.name) ? 'disabled' : 'unknown',
      detail: disabled.has(d.name) ? 'Disabled for this project' : statuses === null ? 'claude CLI not found or status check failed' : null,
    });
  }
  for (const s of statuses ?? []) {
    const existing = byName.get(s.name);
    const isUrl = /^https?:\/\//.test(s.target);
    const scope: ConfigScope = s.name.startsWith('claude.ai ') ? 'claudeai' : s.name.startsWith('plugin:') ? 'plugin' : 'user';
    const state: McpState = disabled.has(s.name) ? 'disabled' : s.state;
    byName.set(s.name, {
      name: s.name,
      scope: existing?.scope ?? scope,
      transport: existing?.transport ?? (isUrl ? 'http' : 'stdio'),
      command: existing?.command ?? (isUrl ? null : s.target),
      url: existing?.url ?? (isUrl ? s.target : null),
      state,
      detail: state === 'connected' ? null : (s.detail ?? (state === 'needs-auth' ? 'Needs authentication' : null)),
    });
  }
  return [...byName.values()];
}

/** Full MCP view for a project: definitions plus live state. Status is null when the CLI could not run. */
export async function listMcp(root: string, home: string): Promise<McpServerInfo[]> {
  const output = await runMcpList(root, home);
  const statuses = output === null ? null : parseMcpList(output);
  return mergeMcp(listMcpDefinitions(root, home), statuses, disabledMcpNames(root, home));
}

/** Servers from the settings files alone, without running the CLI: states stay unknown (or disabled). */
export function listMcpConfigured(root: string, home: string): McpServerInfo[] {
  return mergeMcp(listMcpDefinitions(root, home), [], disabledMcpNames(root, home));
}
