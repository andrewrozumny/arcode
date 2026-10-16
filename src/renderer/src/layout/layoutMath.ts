/** Pure sizing rules for the panel layout. */
import type { PanelLayout } from '@shared/app';

export const TREE_MIN_PX = 180;
export const VIEWER_MIN_PX = 240;
export const TERMINAL_MIN_PX = 80;
export const VIEWER_MIN_HEIGHT_PX = 80;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Tree width in px for a window width, honouring the minimums on both sides. */
export function treeWidthPx(fraction: number, totalPx: number): number {
  return Math.round(clamp(fraction * totalPx, TREE_MIN_PX, Math.max(TREE_MIN_PX, totalPx - VIEWER_MIN_PX)));
}

export function terminalHeightPx(fraction: number, totalPx: number): number {
  return Math.round(
    clamp(fraction * totalPx, TERMINAL_MIN_PX, Math.max(TERMINAL_MIN_PX, totalPx - VIEWER_MIN_HEIGHT_PX)),
  );
}

/** Px back to a fraction after a drag, clamped the same way. */
export function treeFraction(px: number, totalPx: number): number {
  return totalPx > 0 ? treeWidthPx(px / totalPx, totalPx) / totalPx : 0.29;
}

export function terminalFraction(px: number, totalPx: number): number {
  return totalPx > 0 ? terminalHeightPx(px / totalPx, totalPx) / totalPx : 0.39;
}

/** Cmd+Shift+F12: hide both panels, or bring back what was visible before. */
export function togglePanels(
  layout: PanelLayout,
  remembered: Pick<PanelLayout, 'treeVisible' | 'terminalVisible'> | null,
): { layout: PanelLayout; remembered: Pick<PanelLayout, 'treeVisible' | 'terminalVisible'> | null } {
  if (layout.treeVisible || layout.terminalVisible) {
    return {
      layout: { ...layout, treeVisible: false, terminalVisible: false },
      remembered: { treeVisible: layout.treeVisible, terminalVisible: layout.terminalVisible },
    };
  }
  const restore = remembered ?? { treeVisible: true, terminalVisible: true };
  return { layout: { ...layout, ...restore }, remembered: null };
}
