import type { DirEntry, ExternalEntry, FilesApi, SearchRange } from '@shared/files';

export const ROW_HEIGHT = 22;

export interface Row {
  /** Project-relative path with forward slashes. */
  rel: string;
  name: string;
  depth: number;
  kind: DirEntry['kind'];
  ignored: boolean;
  heavy: boolean;
  expanded: boolean;
}

/** `window.acode.files`, exposed by the preload script. */
export function getFilesApi(): FilesApi {
  return window.acode.files;
}

/** Flattens loaded directories into the list of visible rows. */
export function flatten(children: ReadonlyMap<string, DirEntry[]>, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number): void => {
    const entries = children.get(dir);
    if (!entries) return;
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      const isOpen = entry.kind === 'dir' && expanded.has(rel);
      rows.push({
        rel,
        name: entry.name,
        depth,
        kind: entry.kind,
        ignored: entry.ignored,
        heavy: entry.heavy,
        expanded: isOpen,
      });
      if (isOpen) walk(rel, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

export function parentOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function joinPath(root: string, rel: string): string {
  const base = root.replace(/\/+$/, '');
  return rel ? `${base}/${rel}` : base;
}

/** Absolute path to project-relative one; null when the path is outside `root`. */
export function toRel(root: string, abs: string): string | null {
  const base = root.replace(/\/+$/, '');
  if (abs === base) return '';
  return abs.startsWith(base + '/') ? abs.slice(base.length + 1) : null;
}

export function ancestorsOf(rel: string): string[] {
  const parts = rel.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function hasHeavySegment(rel: string, heavy: ReadonlySet<string>): boolean {
  return rel.split('/').some((part) => heavy.has(part));
}

/** Remaps a path after `from` was renamed to `to` (applies to `from` itself and everything under it). */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(from + '/') ? to + path.slice(from.length) : path;
}

export interface Segment {
  text: string;
  match: boolean;
}

/** Splits text[offset..offset+length) into matched / unmatched segments using ranges on the full string. */
export function highlightSegments(full: string, ranges: readonly SearchRange[], from: number, to: number): Segment[] {
  const out: Segment[] = [];
  let cursor = from;
  for (const range of ranges) {
    const start = Math.max(range.start, from);
    const end = Math.min(range.end, to);
    if (end <= start) continue;
    if (start > cursor) out.push({ text: full.slice(cursor, start), match: false });
    out.push({ text: full.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < to) out.push({ text: full.slice(cursor, to), match: false });
  return out;
}

/** Splits `App.tsx:40` into the query and a 1-based line. */
export function parseQuery(input: string): { query: string; line?: number } {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(input);
  if (match) return { query: match[1] ?? '', line: Number(match[2]) };
  return { query: input };
}

export type ExternalSortKey = 'name' | 'date' | 'size';
export type SortDirection = 'asc' | 'desc';

export interface ExternalSort {
  key: ExternalSortKey;
  dir: SortDirection;
}

/** Import dialog default: newest first. */
export const DEFAULT_EXTERNAL_SORT: ExternalSort = { key: 'date', dir: 'desc' };

/** Header click: same key flips direction; a new key starts ascending for names, newest/largest first otherwise. */
export function nextExternalSort(prev: ExternalSort, key: ExternalSortKey): ExternalSort {
  if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

/** Files first (the newest download is what you came for), then folders; each by the chosen key, ties by name. */
export function sortExternalEntries(entries: readonly ExternalEntry[], sort: ExternalSort): ExternalEntry[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const byName = (a: ExternalEntry, b: ExternalEntry): number =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
    let cmp = 0;
    if (sort.key === 'date') cmp = a.mtimeMs - b.mtimeMs;
    else if (sort.key === 'size') cmp = a.size - b.size;
    else cmp = byName(a, b);
    if (cmp === 0 && sort.key !== 'name') cmp = byName(a, b);
    return cmp * sign;
  });
}

/** Multi-selection of tree rows: `items` are highlighted, `focus` is the keyboard row, `anchor` starts Shift ranges. */
export interface TreeSelection {
  items: ReadonlySet<string>;
  focus: string | null;
  anchor: string | null;
}

export const EMPTY_SELECTION: TreeSelection = { items: new Set(), focus: null, anchor: null };

/** Just one row selected; it becomes the focus and the anchor. */
export function singleSelection(rel: string | null): TreeSelection {
  return rel === null ? EMPTY_SELECTION : { items: new Set([rel]), focus: rel, anchor: rel };
}

/** Paths of the visible rows between `from` and `to`, both included, in row order; only `to` when `from` is not visible. */
export function rangeBetween(rows: readonly Pick<Row, 'rel'>[], from: string | null, to: string): string[] {
  const end = rows.findIndex((r) => r.rel === to);
  if (end < 0) return [];
  const start = from === null ? -1 : rows.findIndex((r) => r.rel === from);
  if (start < 0) return [to];
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return rows.slice(lo, hi + 1).map((r) => r.rel);
}

/**
 * Finder-style click: plain selects one row, `toggle` (Cmd) flips a row in or out, `range` (Shift)
 * selects anchor..row (Cmd+Shift adds that range to the selection). Plain and Cmd clicks move the anchor.
 */
export function clickSelection(
  sel: TreeSelection,
  rows: readonly Pick<Row, 'rel'>[],
  rel: string,
  mods: { toggle: boolean; range: boolean },
): TreeSelection {
  if (mods.range) {
    const range = rangeBetween(rows, sel.anchor, rel);
    const items = new Set(mods.toggle ? [...sel.items, ...range] : range);
    return { items, focus: rel, anchor: sel.anchor !== null && items.has(sel.anchor) ? sel.anchor : rel };
  }
  if (mods.toggle) {
    const items = new Set(sel.items);
    if (items.has(rel)) items.delete(rel);
    else items.add(rel);
    return { items, focus: rel, anchor: rel };
  }
  return singleSelection(rel);
}

/** Drops paths nested under another path of the list, so a folder and its contents are handled once. */
export function topmostPaths(paths: readonly string[]): string[] {
  const set = new Set(paths);
  return [...set].filter((p) => !ancestorsOf(p).some((a) => set.has(a)));
}

/** True when `path` is one of `roots` or lies inside one of them. */
export function isUnderAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** The selection minus `gone` and everything inside it; focus and anchor drop out when they went too. */
export function withoutPaths(sel: TreeSelection, gone: readonly string[]): TreeSelection {
  if (gone.length === 0) return sel;
  const keep = (p: string | null): string | null => (p !== null && isUnderAny(p, gone) ? null : p);
  return {
    items: new Set([...sel.items].filter((p) => !isUnderAny(p, gone))),
    focus: keep(sel.focus),
    anchor: keep(sel.anchor),
  };
}

/** Error shown when a bulk delete stops part way: how many went to the Trash and which item failed. */
export function partialDeleteMessage(moved: number, total: number, failedRel: string, error: string): string {
  return `Moved ${moved} of ${total}; failed: ${baseName(failedRel)}: ${error}`;
}
