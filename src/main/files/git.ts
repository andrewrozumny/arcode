import { spawn } from 'node:child_process';
import type { GitBranch } from '@shared/files';

export interface GitResult {
  code: number;
  stdout: Buffer;
}

/** Runs git in `cwd`, optionally feeding stdin. Never rejects on non-zero exit; rejects if git cannot start. */
export function runGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    // GIT_OPTIONAL_LOCKS=0: `git status` must not refresh the index. Doing so takes index.lock, which
    // makes a commit running in the terminal at that moment fail, and the rewritten .git/index wakes
    // the watcher for another status run.
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(chunks) }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

const repoCache = new Map<string, { at: number; value: boolean }>();

/** True when `root` is inside a git work tree. Cached briefly. */
export async function isGitRepo(root: string): Promise<boolean> {
  const hit = repoCache.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  let value = false;
  try {
    const result = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
    value = result.code === 0 && result.stdout.toString().trim() === 'true';
  } catch {
    value = false;
  }
  repoCache.set(root, { at: Date.now(), value });
  return value;
}

/** Current branch, or the short sha on a detached HEAD; null outside a repository. */
export async function getBranch(root: string): Promise<GitBranch | null> {
  if (!(await isGitRepo(root))) return null;
  try {
    const ref = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (ref.code !== 0) return null;
    const name = ref.stdout.toString().trim();
    if (name && name !== 'HEAD') return { name, detached: false };
    const sha = await runGit(root, ['rev-parse', '--short', 'HEAD']);
    const short = sha.stdout.toString().trim();
    return sha.code === 0 && short ? { name: short, detached: true } : null;
  } catch {
    return null;
  }
}
