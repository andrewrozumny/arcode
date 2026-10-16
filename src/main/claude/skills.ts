import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SkillInfo } from '@shared/claude';
import { applicableInstalls } from './plugins';
import { parseFrontmatter } from './common';

/** Skills directly under `dir/<name>/SKILL.md`. Folders without a SKILL.md are ignored. */
function scanDir(dir: string, scope: SkillInfo['scope'], pluginName: string | null): SkillInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      // Symlinked skill folders count too (Claude Code follows them); the SKILL.md check below filters the rest.
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const dirName of names) {
    const file = join(dir, dirName, 'SKILL.md');
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name || basename(dirName),
      description: fm.description || null,
      scope,
      path: file,
      pluginName,
    });
  }
  return out;
}

/** User, project and plugin skills available to a project, in that order. */
export function listSkills(root: string, home: string): SkillInfo[] {
  const skills = [
    ...scanDir(join(home, '.claude', 'skills'), 'user', null),
    ...scanDir(join(root, '.claude', 'skills'), 'project', null),
  ];
  for (const [id, install] of applicableInstalls(root, home)) {
    if (!install.installPath) continue;
    const pluginName = id.slice(0, Math.max(0, id.lastIndexOf('@'))) || id;
    skills.push(...scanDir(join(install.installPath, 'skills'), 'plugin', pluginName));
  }
  return skills;
}
