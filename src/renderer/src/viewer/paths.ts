/** Pure path helpers for the viewer (POSIX paths, project-relative). */

export function normalizeRel(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** Absolute path inside root -> project-relative; relative input is normalized; outside root -> null. */
export function toRelative(root: string, path: string): string | null {
  if (path.startsWith('/')) {
    const base = root.endsWith('/') ? root.slice(0, -1) : root;
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    return normalizeRel(path.slice(base.length));
  }
  return normalizeRel(path);
}

export function toAbsolute(root: string, relPath: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return `${base}/${relPath}`;
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function extension(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

export type GitKind = 'added' | 'modified' | 'untracked' | 'deleted';

/** Accepts porcelain codes ("M", " M", "??", "A") or words ("modified", "untracked"). */
export function gitKind(value: string | undefined): GitKind | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith('?') || v.startsWith('u')) return 'untracked';
  if (v.startsWith('a')) return 'added';
  if (v.startsWith('d')) return 'deleted';
  if (v.startsWith('m') || v.startsWith('r') || v.startsWith('c')) return 'modified';
  return null;
}
