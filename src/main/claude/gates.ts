import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { AREA_ROOTS, buildGates, coverageAreas, RESULT_NOTE } from '@shared/gates';
import type { GatesOverview } from '@shared/claude';
import { isRecord, readJson } from './common';

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Lists the test files under a folder as project-relative paths with their text. */
function testFilesUnder(root: string, rel: string, into: { path: string; text: string }[]): void {
  const abs = join(root, rel);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const childRel = `${rel}/${name}`;
    const childAbs = join(root, childRel);
    // lstat: symlinks are not followed, so a link to an ancestor cannot recurse forever and a
    // dangling one cannot throw the whole overview away.
    const info = lstatOrNull(childAbs);
    if (!info) continue;
    if (info.isDirectory()) {
      testFilesUnder(root, childRel, into);
    } else if (info.isFile() && /\.test\.tsx?$/.test(name)) {
      try {
        into.push({ path: childRel, text: readFileSync(childAbs, 'utf8') });
      } catch {
        // Vanished or unreadable; skip it.
      }
    }
  }
}

/**
 * Area folders: each area root that exists, plus each of its subfolders. Folders without tests are
 * kept on purpose; a project with none of the area roots gets no areas.
 */
function areaFolders(root: string): string[] {
  const folders: string[] = [];
  for (const base of AREA_ROOTS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, base));
    } catch {
      continue;
    }
    folders.push(base);
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      if (lstatOrNull(join(root, base, name))?.isDirectory()) folders.push(`${base}/${name}`);
    }
  }
  return folders;
}

/** Read-only overview of the project's gates and test coverage. `root` must already be checked by the caller. */
export function readGatesOverview(root: string): GatesOverview {
  const pkg = readJson(join(root, 'package.json'));
  const scripts: Record<string, string> = {};
  if (isRecord(pkg) && isRecord(pkg.scripts)) {
    for (const [name, value] of Object.entries(pkg.scripts)) {
      if (typeof value === 'string') scripts[name] = value;
    }
  }
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm';

  const testFiles: { path: string; text: string }[] = [];
  for (const base of AREA_ROOTS) {
    if (existsSync(join(root, base))) testFilesUnder(root, base, testFiles);
  }
  return {
    gates: buildGates(scripts, pm),
    areas: coverageAreas(areaFolders(root), testFiles),
    resultNote: RESULT_NOTE,
  };
}
