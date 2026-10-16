import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * Keeps xterm's hidden helper textarea on the terminal cursor.
 *
 * macOS anchors its input source indicator (the language hint shown when the keyboard layout
 * changes) to the caret of the focused text field, which in a terminal is that textarea. xterm
 * moves it to the cursor only when output moves the cursor; before that it sits at -9999em, and
 * after a resize, a font size change or a scroll back to the bottom it keeps a stale position.
 * Re-syncing on focus and on those events gives the system a caret where the user is looking.
 */

export interface CaretInput {
  cursorX: number;
  cursorY: number;
  cols: number;
  rows: number;
  /** Top line of the viewport and of the live screen; they differ while scrolled back. */
  viewportY: number;
  baseY: number;
  cellWidth: number;
  cellHeight: number;
  /** Width in cells of the character under the cursor (0 for the right half of a wide one). */
  charWidth: number;
}

export interface CaretRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pixel rectangle of the cursor cell inside the terminal screen, or null when it is not visible. */
export function caretRect(input: CaretInput): CaretRect | null {
  const { cursorY, cols, rows, cellWidth, cellHeight } = input;
  if (cols <= 0 || rows <= 0 || !(cellWidth > 0) || !(cellHeight > 0)) return null;
  const row = input.baseY + cursorY - input.viewportY;
  if (row < 0 || row >= rows) return null;
  const col = Math.min(Math.max(input.cursorX, 0), cols - 1);
  return {
    left: col * cellWidth,
    top: row * cellHeight,
    // Never zero: the system needs a real rectangle to place the indicator.
    width: Math.max(1, input.charWidth) * cellWidth,
    height: cellHeight,
  };
}

/** Moves the helper textarea onto the cursor cell, like xterm does on cursor moves. */
export function syncInputCaret(term: Terminal): void {
  const textarea = term.textarea;
  const element = term.element;
  if (!textarea || !element) return;
  // During IME composition xterm positions the textarea itself.
  if (element.querySelector('.composition-view.active')) return;
  const screen = element.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return;
  // xterm sets the screen size inline in CSS pixels; reading it avoids a forced layout.
  const width = parseFloat(screen.style.width);
  const height = parseFloat(screen.style.height);
  const buffer = term.buffer.active;
  const rect = caretRect({
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    cols: term.cols,
    rows: term.rows,
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    cellWidth: width / term.cols,
    cellHeight: height / term.rows,
    charWidth: buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX)?.getWidth() ?? 1,
  });
  if (!rect) return;
  const style = textarea.style;
  style.left = `${rect.left}px`;
  style.top = `${rect.top}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  style.lineHeight = `${rect.height}px`;
}

/** Re-syncs the textarea whenever xterm itself would leave it off the cursor. */
export function trackInputCaret(term: Terminal): IDisposable {
  const sync = (): void => syncInputCaret(term);
  // A resize (also from a font size change) re-measures cells when xterm renders, so wait a frame.
  let frame = 0;
  const syncSoon = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  };
  const textarea = term.textarea;
  textarea?.addEventListener('focus', sync);
  // onScroll fires for every line feed while output streams in; one sync per frame is enough.
  const subscriptions = [term.onResize(syncSoon), term.onScroll(syncSoon)];
  return {
    dispose: () => {
      cancelAnimationFrame(frame);
      textarea?.removeEventListener('focus', sync);
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
