import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { HEAVY_DIRS } from '@shared/files';

/**
 * Classifies a path reported by the watcher (relative to the project root, forward slashes).
 * Returns null for noise (heavy folders, git internals that do not affect status).
 *  - 'git': .git/index, .git/HEAD, .git/refs/**: recompute status only.
 *  - 'structure' / 'content' decided by the caller from the event type.
 */
export function classifyWatchPath(rel: string): 'git' | 'project' | null {
  const parts = rel.split('/');
  if (parts[0] === '.git') {
    if (parts.length === 2 && (parts[1] === 'index' || parts[1] === 'HEAD')) return 'git';
    if (parts[1] === 'refs') return 'git';
    return null;
  }
  for (const part of parts) if (HEAVY_DIRS.has(part)) return null;
  return 'project';
}

export interface WatchBatch {
  /** Project-relative paths that changed (excludes git internals). */
  paths: string[];
  /** True when something was created, deleted or renamed (file list may differ). */
  structural: boolean;
  /** True when git state (index/HEAD/refs) changed. */
  git: boolean;
}

export interface WatcherOptions {
  debounceMs?: number;
  /** Longest a batch may wait while changes keep coming (a log file written every 100 ms). */
  maxWaitMs?: number;
  onBatch(batch: WatchBatch): void;
}

export interface ProjectWatcher {
  close(): void;
}

/** Recursive fs.watch (native FSEvents on macOS) with debounce and heavy-folder filtering. */
export function watchProject(root: string, options: WatcherOptions): ProjectWatcher {
  const debounceMs = options.debounceMs ?? 300;
  const maxWaitMs = options.maxWaitMs ?? 2000;
  let paths = new Set<string>();
  let structural = false;
  let git = false;
  let timer: NodeJS.Timeout | null = null;
  /** When the oldest unflushed change arrived; null when nothing is pending. */
  let pendingSince: number | null = null;

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingSince = null;
    if (paths.size === 0 && !git) return;
    const batch: WatchBatch = { paths: [...paths], structural, git };
    paths = new Set();
    structural = false;
    git = false;
    options.onBatch(batch);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      if (!filename) return;
      const rel = filename.toString().split('\\').join('/');
      const kind = classifyWatchPath(rel);
      if (!kind) return;
      if (kind === 'git') {
        git = true;
      } else {
        paths.add(rel);
        if (eventType === 'rename') structural = true;
        // Any working-tree change can alter git status.
        git = true;
      }
      const now = Date.now();
      pendingSince ??= now;
      if (timer) clearTimeout(timer);
      // Trailing debounce, but never past maxWaitMs from the first pending change.
      timer = setTimeout(flush, Math.max(0, Math.min(debounceMs, pendingSince + maxWaitMs - now)));
    });
    watcher.on('error', () => undefined);
  } catch {
    watcher = null;
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
    },
  };
}
