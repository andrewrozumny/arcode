/**
 * The one path guard of the main process. Every IPC call that names a file by project-relative path
 * (tree, viewer, import) resolves it here, so `..`, absolute paths and symlinks that lead out of the
 * project are refused the same way everywhere.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Normalizes a project-relative path to forward slashes without leading/trailing slashes. Throws if it escapes. */
export function normalizeRel(rel: string): string {
  if (rel.includes('\0')) throw new Error('Invalid path');
  if (isAbsolute(rel)) throw new Error(`Path must be relative to the project root: ${rel}`);
  const parts: string[] = [];
  for (const part of rel.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error(`Path escapes the project root: ${rel}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** True when absolute `target` is `base` or lies under it (purely lexical, no symlinks followed). */
export function isInside(base: string, target: string): boolean {
  const r = relative(base, target);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
}

async function realpathOfExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Resolves a project-relative path to an absolute one and guarantees it stays inside `root`,
 * including after following symlinks. Throws otherwise.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const normalized = normalizeRel(rel);
  const absRoot = resolve(root);
  const abs = normalized === '' ? absRoot : resolve(absRoot, normalized);
  if (!isInside(absRoot, abs)) throw new Error(`Path escapes the project root: ${rel}`);
  const realRoot = await realpath(absRoot);
  const realTarget = await realpathOfExistingAncestor(abs);
  if (!isInside(realRoot, realTarget)) throw new Error(`Path escapes the project root via symlink: ${rel}`);
  return abs;
}

/**
 * Like resolveInside, for an operation on the entry itself (rename, delete): only its parent folder
 * must resolve inside the root. A symlink kept in the project that points elsewhere is still the
 * project's own entry, and renaming or trashing it never touches the target.
 */
export async function resolveEntryInside(root: string, rel: string): Promise<string> {
  const normalized = normalizeRel(rel);
  if (normalized === '') throw new Error('Cannot modify the project root');
  const parent = await resolveInside(root, dirname(normalized) === '.' ? '' : dirname(normalized));
  return join(parent, basename(normalized));
}
