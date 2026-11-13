import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@shared/app';
import { TREE_MIN_PX, discussionWidthPx, togglePanels, treeWidthPx } from './layoutMath';

describe('layout math', () => {
  it('applies the tree minimum width', () => {
    expect(treeWidthPx(0.29, 1000)).toBe(290);
    expect(treeWidthPx(0.05, 1000)).toBe(TREE_MIN_PX);
  });

  it('hides both panels and restores what was visible', () => {
    const start = { ...DEFAULT_LAYOUT, terminalVisible: false };
    const hidden = togglePanels(start, null);
    expect(hidden.layout.treeVisible || hidden.layout.terminalVisible).toBe(false);
    const shown = togglePanels(hidden.layout, hidden.remembered);
    expect(shown.layout).toEqual(start);
  });
});

describe('discussionWidthPx', () => {
  it('keeps the column within its bounds', () => {
    expect(discussionWidthPx(100, 2000)).toBe(260);
    expect(discussionWidthPx(900, 2000)).toBe(640);
    expect(discussionWidthPx(400, 2000)).toBe(400);
  });

  it('never squeezes the viewer below its minimum', () => {
    // 700 px of room: the viewer keeps 240, so the column gets at most 460.
    expect(discussionWidthPx(600, 700)).toBe(460);
    // Too little room even for the column's minimum: the minimum wins.
    expect(discussionWidthPx(600, 300)).toBe(260);
  });
});
