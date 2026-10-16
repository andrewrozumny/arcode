import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';

export interface IgnoreMatcher {
  /** `rel` is project-relative with forward slashes. */
  isIgnored(rel: string, isDir: boolean): Promise<boolean>;
}

/** .gitignore matcher for projects outside git: honors the root file and nested ones. */
export function createIgnoreMatcher(root: string): IgnoreMatcher {
  const cache = new Map<string, Promise<Ignore | null>>();

  function load(dirRel: string): Promise<Ignore | null> {
    let entry = cache.get(dirRel);
    if (!entry) {
      entry = readFile(join(root, dirRel, '.gitignore'), 'utf8').then(
        (text) => ignore().add(text),
        () => null,
      );
      cache.set(dirRel, entry);
    }
    return entry;
  }

  return {
    async isIgnored(rel, isDir) {
      const parts = rel.split('/');
      // Check every ancestor directory's .gitignore, from the root down to the parent.
      for (let depth = 0; depth < parts.length; depth++) {
        const dirRel = parts.slice(0, depth).join('/');
        const ig = await load(dirRel);
        if (!ig) continue;
        const sub = parts.slice(depth).join('/');
        if (ig.ignores(isDir ? sub + '/' : sub)) return true;
      }
      return false;
    },
  };
}
