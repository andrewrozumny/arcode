import { describe, expect, it } from 'vitest';
import {
  MAX_TAB_TITLE_LENGTH,
  MAX_TAB_TITLES,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  clampSplitRatio,
  sanitizeTabTitles,
  sanitizeTerminalState,
} from './terminal';

describe('sanitizeTerminalState split', () => {
  const shell = (id: string) => ({ id, kind: 'shell', title: id });
  const tabs = [shell('a'), shell('b'), shell('c')];

  it('loads old state without a split as one column', () => {
    const state = sanitizeTerminalState({ tabs, activeTabId: 'b', composerOpen: false });
    expect(state).toEqual({ tabs, activeTabId: 'b', composerOpen: false });
    expect(state && 'split' in state).toBe(false);
  });

  it('keeps a valid split in strip order', () => {
    const state = sanitizeTerminalState({
      tabs,
      activeTabId: 'a',
      composerOpen: false,
      split: { rightTabIds: ['c', 'b'], rightActiveTabId: 'c', ratio: 0.6 },
    });
    expect(state?.split).toEqual({ rightTabIds: ['b', 'c'], rightActiveTabId: 'c', ratio: 0.6 });
    expect(state?.activeTabId).toBe('a');
  });

  it('drops unknown and duplicate ids and a right active tab that is not on the right', () => {
    const state = sanitizeTerminalState({
      tabs,
      activeTabId: 'a',
      composerOpen: false,
      split: { rightTabIds: ['c', 'c', 'nope', 7], rightActiveTabId: 'a', ratio: 0.5 },
    });
    expect(state?.split).toEqual({ rightTabIds: ['c'], rightActiveTabId: null, ratio: 0.5 });
  });

  it('drops a split that would leave a column empty', () => {
    const none = sanitizeTerminalState({ tabs, activeTabId: null, composerOpen: false, split: { rightTabIds: ['x'] } });
    expect(none?.split).toBeUndefined();
    const all = sanitizeTerminalState({
      tabs,
      activeTabId: null,
      composerOpen: false,
      split: { rightTabIds: ['a', 'b', 'c'], rightActiveTabId: 'a', ratio: 0.5 },
    });
    expect(all?.split).toBeUndefined();
    expect(sanitizeTerminalState({ tabs, activeTabId: null, composerOpen: false, split: 'yes' })?.split).toBeUndefined();
  });

  it('does not keep a left active tab that sits on the right', () => {
    const state = sanitizeTerminalState({
      tabs,
      activeTabId: 'c',
      composerOpen: false,
      split: { rightTabIds: ['c'], rightActiveTabId: 'c', ratio: 0.5 },
    });
    expect(state?.activeTabId).toBeNull();
  });

  it('clamps the ratio and defaults a bad one', () => {
    expect(clampSplitRatio(0.01)).toBe(SPLIT_RATIO_MIN);
    expect(clampSplitRatio(2)).toBe(SPLIT_RATIO_MAX);
    expect(clampSplitRatio(Number.NaN)).toBe(SPLIT_RATIO_DEFAULT);
    expect(clampSplitRatio('0.3')).toBe(SPLIT_RATIO_DEFAULT);
    expect(clampSplitRatio(0.3)).toBe(0.3);
  });
});

describe('sanitizeTabTitles', () => {
  it('keeps valid pty titles and drops junk', () => {
    const titles = sanitizeTabTitles([
      { ptyId: 1, title: ' Claude ' },
      { ptyId: 2.5, title: 'fraction' },
      { ptyId: '3', title: 'string id' },
      { ptyId: 4, title: 42 },
      { ptyId: 5, title: '   ' },
      'nope',
      null,
    ]);
    expect([...titles]).toEqual([[1, 'Claude']]);
  });

  it('returns an empty map for anything but an array', () => {
    expect(sanitizeTabTitles(undefined).size).toBe(0);
    expect(sanitizeTabTitles({ ptyId: 1, title: 'x' }).size).toBe(0);
  });

  it('caps the number and the length of titles', () => {
    const many = Array.from({ length: MAX_TAB_TITLES + 20 }, (_, i) => ({ ptyId: i, title: 'x'.repeat(500) }));
    const titles = sanitizeTabTitles(many);
    expect(titles.size).toBe(MAX_TAB_TITLES);
    expect(titles.get(0)).toHaveLength(MAX_TAB_TITLE_LENGTH);
  });
});
