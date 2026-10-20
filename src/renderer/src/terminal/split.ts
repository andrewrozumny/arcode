/**
 * Pure model of the split terminal dock: which column each tab sits in, the active tab of each
 * column and which column has focus. Free of React and DOM types so the rules are unit-testable.
 *
 * Tabs stay in one list (strip order within a column is list order); a tab without `column`
 * belongs to the left column. The dock is split while both columns hold at least one tab.
 */

export type Column = 0 | 1;

export interface ColumnTab {
  id: string;
  /** 1 for the right column; absent or 0 for the left one. */
  column?: Column | undefined;
}

export interface SplitView {
  /** Active tab of the left and the right column. */
  active: readonly [string | null, string | null];
  /** Column that receives keyboard commands, composer text and new tabs. */
  focused: Column;
}

export interface SplitResult<T extends ColumnTab> {
  tabs: T[];
  view: SplitView;
}

export const EMPTY_VIEW: SplitView = { active: [null, null], focused: 0 };

export function columnOf(tab: ColumnTab): Column {
  return tab.column === 1 ? 1 : 0;
}

export function tabsIn<T extends ColumnTab>(tabs: readonly T[], column: Column): T[] {
  return tabs.filter((t) => columnOf(t) === column);
}

export function isSplit(tabs: readonly ColumnTab[]): boolean {
  let left = false;
  let right = false;
  for (const tab of tabs) {
    if (columnOf(tab) === 1) right = true;
    else left = true;
    if (left && right) return true;
  }
  return false;
}

/** Tabs in the order the user sees them: the left strip, then the right one. */
export function displayOrder<T extends ColumnTab>(tabs: readonly T[]): T[] {
  return [...tabsIn(tabs, 0), ...tabsIn(tabs, 1)];
}

/** The tab keyboard commands act on: the active tab of the focused column. */
export function focusedTabId(view: SplitView): string | null {
  return view.active[view.focused];
}

function withColumn<T extends ColumnTab>(tab: T, column: Column): T {
  if (columnOf(tab) === column) return tab;
  const next = { ...tab };
  if (column === 1) next.column = 1;
  else delete next.column;
  return next;
}

/**
 * Restores the invariants after any change: a lone right column becomes the left column, every
 * column's active tab lives in that column (falling back to its first tab), and an unsplit dock
 * has focus on the left with no right active tab.
 */
export function normalize<T extends ColumnTab>(tabs: readonly T[], view: SplitView): SplitResult<T> {
  let next = [...tabs];
  let [left, right] = view.active;
  let focused = view.focused;
  if (next.length > 0 && next.every((t) => columnOf(t) === 1)) {
    next = next.map((t) => withColumn(t, 0));
    left = right ?? left;
    right = null;
    focused = 0;
  }
  const pick = (column: Column, id: string | null): string | null => {
    const inColumn = tabsIn(next, column);
    return inColumn.some((t) => t.id === id) ? id : (inColumn[0]?.id ?? null);
  };
  left = pick(0, left);
  right = pick(1, right);
  if (right === null) focused = 0;
  return { tabs: next, view: { active: [left, right], focused } };
}

/** Appends a tab to a column, makes it that column's active tab and focuses the column. */
export function placeTab<T extends ColumnTab>(
  tabs: readonly T[],
  view: SplitView,
  tab: T,
  column: Column,
): SplitResult<T> {
  const active: [string | null, string | null] = [...view.active];
  active[column] = tab.id;
  return normalize([...tabs, withColumn(tab, column)], { active, focused: column });
}

/** Makes a tab the active one of its column and focuses that column. */
export function activateTab<T extends ColumnTab>(tabs: readonly T[], view: SplitView, id: string): SplitResult<T> {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return normalize(tabs, view);
  const column = columnOf(tab);
  const active: [string | null, string | null] = [...view.active];
  active[column] = id;
  return normalize(tabs, { active, focused: column });
}

/** Focuses a column without changing its active tab; ignored when that column is empty. */
export function focusColumn<T extends ColumnTab>(tabs: readonly T[], view: SplitView, column: Column): SplitResult<T> {
  if (tabsIn(tabs, column).length === 0) return normalize(tabs, view);
  return normalize(tabs, { ...view, focused: column });
}

/** The tab that takes over when `id` leaves its column: the next one in the strip, else the previous. */
function neighbor(columnTabs: readonly ColumnTab[], id: string): string | null {
  const index = columnTabs.findIndex((t) => t.id === id);
  const rest = columnTabs.filter((t) => t.id !== id);
  return rest[Math.min(Math.max(index, 0), rest.length - 1)]?.id ?? null;
}

/**
 * Moves a tab to the other column, at the end of its strip. It becomes the active tab there and
 * that column gets focus; the column it left activates a neighbour. Moving the last tab out of a
 * column collapses the dock to one column.
 */
export function moveTab<T extends ColumnTab>(tabs: readonly T[], view: SplitView, id: string): SplitResult<T> {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return normalize(tabs, view);
  const from = columnOf(tab);
  const to: Column = from === 0 ? 1 : 0;
  const active: [string | null, string | null] = [...view.active];
  if (active[from] === id) active[from] = neighbor(tabsIn(tabs, from), id);
  active[to] = id;
  const next = [...tabs.filter((t) => t.id !== id), withColumn(tab, to)];
  return normalize(next, { active, focused: to });
}

/** True when moving the tab would change anything: there is a second tab to keep a column alive. */
export function canMoveTab(tabs: readonly ColumnTab[]): boolean {
  return tabs.length > 1;
}

/**
 * Removes a tab. Its column activates a neighbour; when that column is now empty the dock goes
 * back to one column (the other column's tabs become the left column).
 */
export function removeTab<T extends ColumnTab>(tabs: readonly T[], view: SplitView, id: string): SplitResult<T> {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return normalize(tabs, view);
  const column = columnOf(tab);
  const active: [string | null, string | null] = [...view.active];
  if (active[column] === id) active[column] = neighbor(tabsIn(tabs, column), id);
  const remaining = tabs.filter((t) => t.id !== id);
  const columnEmpty = tabsIn(remaining, column).length === 0;
  // The column that is left gets focus, so the next Cmd+W keeps working where the user is.
  const focused: Column = columnEmpty ? (column === 0 ? 1 : 0) : view.focused;
  return normalize(remaining, { active, focused });
}

/** Activates the next (+1) or previous (-1) tab of the focused column, wrapping around. */
export function stepTab<T extends ColumnTab>(tabs: readonly T[], view: SplitView, step: number): SplitResult<T> {
  const inColumn = tabsIn(tabs, view.focused);
  if (inColumn.length === 0) return normalize(tabs, view);
  const index = inColumn.findIndex((t) => t.id === view.active[view.focused]);
  const target = inColumn[(((index + step) % inColumn.length) + inColumn.length) % inColumn.length];
  return target ? activateTab(tabs, view, target.id) : normalize(tabs, view);
}

/** Builds the columns from saved right-column ids; unknown ids are ignored. */
export function applySavedSplit<T extends ColumnTab>(
  tabs: readonly T[],
  leftActive: string | null,
  split: { rightTabIds: readonly string[]; rightActiveTabId: string | null } | undefined,
): SplitResult<T> {
  const right = new Set(split?.rightTabIds ?? []);
  const placed = tabs.map((t) => withColumn(t, right.has(t.id) ? 1 : 0));
  return normalize(placed, { active: [leftActive, split?.rightActiveTabId ?? null], focused: 0 });
}
