import { join } from 'node:path';
import type { PluginInfo } from '@shared/claude';
import { isRecord, readJson, settingsFiles, stringOrNull } from './common';

export interface InstalledEntry {
  scope: 'user' | 'project';
  installPath: string | null;
  version: string | null;
  installedAt: string | null;
  projectPath: string | null;
}

/** Install records from ~/.claude/plugins/installed_plugins.json that apply to this project. */
export function applicableInstalls(root: string, home: string): Map<string, InstalledEntry> {
  const out = new Map<string, InstalledEntry>();
  const data = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (!isRecord(data) || !isRecord(data.plugins)) return out;
  for (const [id, entries] of Object.entries(data.plugins)) {
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (!isRecord(raw)) continue;
      const projectPath = stringOrNull(raw.projectPath);
      const scope = raw.scope === 'project' ? 'project' : 'user';
      if (scope === 'project' && projectPath !== root) continue;
      // A project-scoped install of the same plugin wins over the user-wide one.
      if (out.has(id) && scope === 'user') continue;
      out.set(id, {
        scope,
        installPath: stringOrNull(raw.installPath),
        version: stringOrNull(raw.version),
        installedAt: stringOrNull(raw.installedAt),
        projectPath,
      });
    }
  }
  return out;
}

/**
 * Whether a plugin is enabled for the project: the value from the highest-precedence settings
 * file that mentions it (local, then project, then user). Unmentioned plugins are disabled.
 */
export function enabledFor(root: string, home: string, id: string): boolean {
  for (const { file } of settingsFiles(root, home)) {
    const settings = readJson(file);
    if (!isRecord(settings) || !isRecord(settings.enabledPlugins)) continue;
    const value = settings.enabledPlugins[id];
    if (typeof value === 'boolean') return value;
  }
  return false;
}

/** Every plugin installed for this project or user-wide, plus plugins enabled in settings only. */
export function listPlugins(root: string, home: string): PluginInfo[] {
  const installs = applicableInstalls(root, home);
  const ids = new Set<string>(installs.keys());
  for (const { file } of settingsFiles(root, home)) {
    const settings = readJson(file);
    if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
      for (const id of Object.keys(settings.enabledPlugins)) ids.add(id);
    }
  }
  const plugins: PluginInfo[] = [];
  for (const id of ids) {
    const at = id.lastIndexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : '';
    const install = installs.get(id);
    plugins.push({
      id,
      name,
      marketplace,
      version: install?.version ?? null,
      enabled: enabledFor(root, home, id),
      scope: install?.scope ?? 'user',
      installedAt: install?.installedAt ?? null,
      path: install?.installPath ?? null,
    });
  }
  return plugins.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id));
}
