import type { PtyId } from '@shared/ipc';

/** The visible lines of a terminal and its width, as text. */
export interface ScreenText {
  lines: string[];
  cols: number;
}

/**
 * Readers of the visible screen of each terminal in this window, by pty. The Claude feed uses
 * them to see which prompt Claude Code shows before it answers one.
 */
const screens = new Map<PtyId, () => ScreenText>();

/** Registers the screen reader of a pty; the returned function removes it. */
export function registerScreen(ptyId: PtyId, read: () => ScreenText): () => void {
  screens.set(ptyId, read);
  return () => {
    if (screens.get(ptyId) === read) screens.delete(ptyId);
  };
}

/** The visible screen of a pty of this window, or null when it has no terminal here. */
export function readScreen(ptyId: PtyId): ScreenText | null {
  return screens.get(ptyId)?.() ?? null;
}
