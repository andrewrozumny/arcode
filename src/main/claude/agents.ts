import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentInfo } from '@shared/claude';
import { parseFrontmatter } from './common';

function scanDir(dir: string, scope: AgentInfo['scope']): AgentInfo[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const out: AgentInfo[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name || basename(file, '.md'),
      description: fm.description || null,
      scope,
      path,
      model: fm.model || null,
    });
  }
  return out;
}

/** Subagents from ~/.claude/agents and <root>/.claude/agents. */
export function listAgents(root: string, home: string): AgentInfo[] {
  return [...scanDir(join(home, '.claude', 'agents'), 'user'), ...scanDir(join(root, '.claude', 'agents'), 'project')];
}
