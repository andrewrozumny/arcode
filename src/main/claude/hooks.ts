import { join } from 'node:path';
import type { HookInfo } from '@shared/claude';
import { isRecord, readJson } from './common';

/**
 * Command hooks from the user, project and local settings files, flattened to one row per command.
 * Shape: { hooks: { [event]: [{ matcher?, hooks: [{ type: 'command', command }] }] } }.
 */
export function listHooks(root: string, home: string): HookInfo[] {
  const sources: { file: string; scope: HookInfo['scope'] }[] = [
    { file: join(home, '.claude', 'settings.json'), scope: 'user' },
    { file: join(root, '.claude', 'settings.json'), scope: 'project' },
    { file: join(root, '.claude', 'settings.local.json'), scope: 'local' },
  ];
  const out: HookInfo[] = [];
  for (const { file, scope } of sources) {
    const settings = readJson(file);
    if (!isRecord(settings) || !isRecord(settings.hooks)) continue;
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
        const matcher = typeof group.matcher === 'string' && group.matcher !== '' ? group.matcher : null;
        for (const hook of group.hooks) {
          if (!isRecord(hook) || hook.type !== 'command' || typeof hook.command !== 'string') continue;
          out.push({ event, matcher, command: hook.command, scope });
        }
      }
    }
  }
  return out;
}
