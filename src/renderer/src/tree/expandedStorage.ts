import { HEAVY_DIRS } from '@shared/files';
import { hasHeavySegment } from './model';

/** Expanded folders of the tree, remembered per project in localStorage. Heavy folders are never restored. */
function storageKey(root: string): string {
  return `acode.tree.expanded:${root}`;
}

export function readExpanded(root: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(root));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string' && !hasHeavySegment(p, HEAVY_DIRS))
      : [];
  } catch {
    return [];
  }
}

export function writeExpanded(root: string, expanded: ReadonlySet<string>): void {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify([...expanded]));
  } catch {
    // storage unavailable; expansion state is just not remembered
  }
}
