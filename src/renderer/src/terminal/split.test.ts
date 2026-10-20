import { describe, expect, it } from 'vitest';
import {
  EMPTY_VIEW,
  activateTab,
  applySavedSplit,
  canMoveTab,
  displayOrder,
  focusColumn,
  focusedTabId,
  isSplit,
  moveTab,
  normalize,
  placeTab,
  removeTab,
  stepTab,
  tabsIn,
} from './split';
import type { ColumnTab, SplitView } from './split';

const left = (id: string): ColumnTab => ({ id });
const right = (id: string): ColumnTab => ({ id, column: 1 });
const ids = (tabs: readonly ColumnTab[]): string[] => tabs.map((t) => t.id);
const view = (l: string | null, r: string | null, focused: 0 | 1 = 0): SplitView => ({ active: [l, r], focused });

describe('split model', () => {
  it('is split only while both columns hold a tab', () => {
    expect(isSplit([])).toBe(false);
    expect(isSplit([left('a'), left('b')])).toBe(false);
    expect(isSplit([left('a'), right('b')])).toBe(true);
  });

  it('turns a lone right column into the left column', () => {
    const { tabs, view: next } = normalize([right('a'), right('b')], view(null, 'b', 1));
    expect(tabs.every((t) => t.column === undefined)).toBe(true);
    expect(next).toEqual(view('b', null, 0));
  });

  it('falls back to the first tab of a column when its active tab is elsewhere', () => {
    const { view: next } = normalize([left('a'), right('b'), right('c')], view('b', 'gone', 1));
    expect(next).toEqual(view('a', 'b', 1));
  });

  it('splits right by placing a tab in column 1, which takes focus', () => {
    const { tabs, view: next } = placeTab([left('a')], view('a', null), right('b'), 1);
    expect(isSplit(tabs)).toBe(true);
    expect(next).toEqual(view('a', 'b', 1));
    expect(focusedTabId(next)).toBe('b');
  });

  it('adds new tabs to the focused column', () => {
    const start = { tabs: [left('a'), right('b')], view: view('a', 'b', 1) };
    const { tabs, view: next } = placeTab(start.tabs, start.view, left('c'), start.view.focused);
    expect(ids(tabsIn(tabs, 1))).toEqual(['b', 'c']);
    expect(next).toEqual(view('a', 'c', 1));
  });

  it('activating a tab focuses its column', () => {
    const { view: next } = activateTab([left('a'), left('b'), right('c')], view('a', 'c', 1), 'b');
    expect(next).toEqual(view('b', 'c', 0));
  });

  it('moves a tab to the other side, keeps the source column alive with a neighbour', () => {
    const tabs = [left('a'), left('b'), left('c')];
    const moved = moveTab(tabs, view('b', null), 'b');
    expect(ids(tabsIn(moved.tabs, 0))).toEqual(['a', 'c']);
    expect(ids(tabsIn(moved.tabs, 1))).toEqual(['b']);
    expect(moved.view).toEqual(view('c', 'b', 1));
    // Moving it back lands it at the end of the left strip and collapses the split.
    const back = moveTab(moved.tabs, moved.view, 'b');
    expect(isSplit(back.tabs)).toBe(false);
    expect(ids(back.tabs)).toEqual(['a', 'c', 'b']);
    expect(back.view).toEqual(view('b', null, 0));
  });

  it('moving the only tab of the left column collapses to the right column as the only one', () => {
    const moved = moveTab([left('a'), right('b')], view('a', 'b'), 'a');
    expect(isSplit(moved.tabs)).toBe(false);
    expect(ids(moved.tabs)).toEqual(['b', 'a']);
    expect(moved.view).toEqual(view('a', null, 0));
  });

  it('cannot move when there is a single tab', () => {
    expect(canMoveTab([left('a')])).toBe(false);
    expect(canMoveTab([left('a'), left('b')])).toBe(true);
  });

  it('closing a tab activates its neighbour in the same column', () => {
    const tabs = [left('a'), right('b'), right('c'), right('d')];
    const { tabs: rest, view: next } = removeTab(tabs, view('a', 'c', 1), 'c');
    expect(ids(rest)).toEqual(['a', 'b', 'd']);
    expect(next).toEqual(view('a', 'd', 1));
    const last = removeTab(rest, view('a', 'd', 1), 'd');
    expect(last.view).toEqual(view('a', 'b', 1));
  });

  it('closing the last tab of the right column collapses to one column with focus on the left', () => {
    const { tabs, view: next } = removeTab([left('a'), left('b'), right('c')], view('b', 'c', 1), 'c');
    expect(isSplit(tabs)).toBe(false);
    expect(next).toEqual(view('b', null, 0));
  });

  it('closing the last tab of the left column makes the right column the only one', () => {
    const { tabs, view: next } = removeTab([left('a'), right('b'), right('c')], view('a', 'c', 0), 'a');
    expect(isSplit(tabs)).toBe(false);
    expect(ids(tabs)).toEqual(['b', 'c']);
    expect(next).toEqual(view('c', null, 0));
  });

  it('steps through the tabs of the focused column only', () => {
    const tabs = [left('a'), right('b'), left('c'), right('d')];
    expect(stepTab(tabs, view('a', 'b', 1), 1).view).toEqual(view('a', 'd', 1));
    expect(stepTab(tabs, view('a', 'd', 1), 1).view).toEqual(view('a', 'b', 1));
    expect(stepTab(tabs, view('a', 'b', 0), -1).view).toEqual(view('c', 'b', 0));
  });

  it('focuses a column only when it has tabs', () => {
    expect(focusColumn([left('a'), right('b')], view('a', 'b'), 1).view.focused).toBe(1);
    expect(focusColumn([left('a')], view('a', null), 1).view.focused).toBe(0);
  });

  it('orders tabs left strip first for jumping between waiting tabs', () => {
    expect(ids(displayOrder([right('a'), left('b'), right('c'), left('d')]))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('rebuilds columns from saved right ids and ignores unknown ones', () => {
    const restored = applySavedSplit([left('a'), left('b'), left('c')], 'a', {
      rightTabIds: ['c', 'zzz'],
      rightActiveTabId: 'c',
    });
    expect(ids(tabsIn(restored.tabs, 1))).toEqual(['c']);
    expect(restored.view).toEqual(view('a', 'c', 0));
  });

  it('loads state without a split as one column', () => {
    const restored = applySavedSplit([left('a'), left('b')], 'b', undefined);
    expect(isSplit(restored.tabs)).toBe(false);
    expect(restored.view).toEqual(view('b', null, 0));
  });

  it('handles the empty dock', () => {
    expect(normalize([], EMPTY_VIEW)).toEqual({ tabs: [], view: EMPTY_VIEW });
    expect(removeTab([left('a')], view('a', null), 'a')).toEqual({ tabs: [], view: EMPTY_VIEW });
  });
});
