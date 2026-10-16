import type { GitStatusCode, GitStatusMap } from '@shared/files';
import { isGitRepo, runGit } from './git';

function codeFor(type: string, xy: string): GitStatusCode {
  if (type === 'u') return 'U';
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  if (type === '2') {
    if (x === 'C' || y === 'C') return 'C';
    return 'R';
  }
  if (x === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  return 'M';
}

/** Parses `git status --porcelain=v2 -z` output into path -> status code. Paths are repo-root relative. */
export function parsePorcelainV2(output: string): Record<string, GitStatusCode> {
  const files: Record<string, GitStatusCode> = {};
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const type = token[0];
    if (type === '?') {
      files[token.slice(2)] = '?';
    } else if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const fields = token.split(' ');
      files[fields.slice(8).join(' ')] = codeFor('1', fields[1] ?? '');
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, followed by a separate NUL-terminated original path.
      const fields = token.split(' ');
      files[fields.slice(9).join(' ')] = codeFor('2', fields[1] ?? '');
      i++;
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = token.split(' ');
      files[fields.slice(10).join(' ')] = 'U';
    }
  }
  return files;
}

/** Every ancestor folder of every changed file. */
export function aggregateDirs(files: Record<string, GitStatusCode>): string[] {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    let idx = path.lastIndexOf('/');
    while (idx > 0) {
      const dir = path.slice(0, idx);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      idx = dir.lastIndexOf('/');
    }
  }
  return [...dirs].sort();
}

export function buildStatusMap(files: Record<string, GitStatusCode>): GitStatusMap {
  return { files, dirs: aggregateDirs(files) };
}

/** Re-bases repo-root-relative paths onto a project root that may be a subfolder of the repo. */
export function stripPrefix(files: Record<string, GitStatusCode>, prefix: string): Record<string, GitStatusCode> {
  if (!prefix) return files;
  const out: Record<string, GitStatusCode> = {};
  for (const [path, code] of Object.entries(files)) {
    if (path.startsWith(prefix)) out[path.slice(prefix.length)] = code;
  }
  return out;
}

export async function getGitStatus(root: string): Promise<GitStatusMap> {
  if (!(await isGitRepo(root))) return { files: {}, dirs: [] };
  try {
    const [status, prefixResult] = await Promise.all([
      runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      runGit(root, ['rev-parse', '--show-prefix']),
    ]);
    if (status.code !== 0) return { files: {}, dirs: [] };
    const prefix = prefixResult.stdout.toString().trim();
    return buildStatusMap(stripPrefix(parsePorcelainV2(status.stdout.toString('utf8')), prefix));
  } catch {
    return { files: {}, dirs: [] };
  }
}
