import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@shared/app';
import { TREE_MIN_PX, togglePanels, treeWidthPx } from './layoutMath';

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
