import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HEAVY_DIRS } from '@shared/files';
import type { DirEntry, EntryKind, FileOp } from '@shared/files';
import { isGitRepo, runGit } from './git';
import { createIgnoreMatcher } from './ignoreFallback';
import { normalizeRel, resolveEntryInside, resolveInside } from './paths';

export function isHeavyName(name: string): boolean {
  return HEAVY_DIRS.has(name);
}

/** Folders first, then names case-insensitively (stable tie-break on exact name). */
export function compareEntries(a: Pick<DirEntry, 'name' | 'kind'>, b: Pick<DirEntry, 'name' | 'kind'>): number {
  const aDir = a.kind === 'dir' ? 0 : 1;
  const bDir = b.kind === 'dir' ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** One `git check-ignore` call for a batch of project-relative paths. Returns null when git is unavailable. */
export async function gitCheckIgnore(root: string, paths: string[]): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set();
  try {
    const result = await runGit(root, ['check-ignore', '--stdin', '-z'], paths.join('\0') + '\0');
    // Exit 0: some ignored, 1: none ignored, 128: fatal (not a repo).
    if (result.code !== 0 && result.code !== 1) return null;
    const out = new Set<string>();
    for (const item of result.stdout.toString('utf8').split('\0')) {
      if (item) out.add(item.replace(/\/$/, ''));
    }
    return out;
  } catch {
    return null;
  }
}

export async function listDir(root: string, relDir: string): Promise<DirEntry[]> {
  const rel = normalizeRel(relDir);
  const abs = await resolveInside(root, rel);
  const dirents = await readdir(abs, { withFileTypes: true });

  const items = dirents.map((d) => {
    const kind: EntryKind = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file';
    return { name: d.name, kind, relPath: rel ? `${rel}/${d.name}` : d.name };
  });

  let ignoredSet: Set<string> | null = null;
  if (rel.split('/').some(isHeavyName)) {
    // Inside a heavy folder everything is shown grey; skip per-entry checks (thousands of paths).
    ignoredSet = new Set(items.map((i) => i.relPath));
  } else if (await isGitRepo(root)) {
    ignoredSet = await gitCheckIgnore(
      root,
      items.map((i) => (i.kind === 'dir' ? i.relPath + '/' : i.relPath)),
    );
  }
  if (!ignoredSet) {
    const matcher = createIgnoreMatcher(root);
    ignoredSet = new Set();
    for (const item of items) {
      if (await matcher.isIgnored(item.relPath, item.kind === 'dir')) ignoredSet.add(item.relPath);
    }
  }

  const entries: DirEntry[] = items.map((i) => ({
    name: i.name,
    kind: i.kind,
    ignored: ignoredSet.has(i.relPath),
    heavy: i.kind === 'dir' && isHeavyName(i.name),
  }));
  entries.sort(compareEntries);
  return entries;
}

/** Create / rename. Deleting goes through the trash in the IPC layer (needs Electron). */
export async function applyFileOp(root: string, op: Exclude<FileOp, { type: 'delete' }>): Promise<void> {
  if (normalizeRel(op.relPath) === '') throw new Error('Cannot modify the project root');
  switch (op.type) {
    case 'createFile': {
      const abs = await resolveInside(root, op.relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, '', { flag: 'wx' });
      return;
    }
    case 'createDir':
      await mkdir(await resolveInside(root, op.relPath), { recursive: true });
      return;
    case 'rename': {
      const from = await resolveEntryInside(root, op.relPath);
      const target = await resolveInside(root, op.newRelPath);
      // lstat: a symlink is renamed as itself, never through to what it points at.
      const [source, existing] = await Promise.all([lstat(from), lstat(target).catch(() => null)]);
      // On a case-insensitive volume `readme.md` -> `README.md` finds the source itself; that is a rename, not a clash.
      const sameFile = existing !== null && existing.ino === source.ino && existing.dev === source.dev;
      if (existing && !sameFile) throw new Error('Target already exists');
      await mkdir(dirname(target), { recursive: true });
      await rename(from, target);
      return;
    }
  }
}
