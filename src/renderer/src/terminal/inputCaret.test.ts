import { describe, expect, it } from 'vitest';
import { caretRect } from './inputCaret';
import type { CaretInput } from './inputCaret';

const base: CaretInput = {
  cursorX: 3,
  cursorY: 2,
  cols: 80,
  rows: 24,
  viewportY: 100,
  baseY: 100,
  cellWidth: 7.5,
  cellHeight: 18,
  charWidth: 1,
};

describe('caretRect', () => {
  it('places the caret on the cursor cell', () => {
    expect(caretRect(base)).toEqual({ left: 22.5, top: 36, width: 7.5, height: 18 });
  });

  it('covers both cells of a wide character and never has zero width', () => {
    expect(caretRect({ ...base, charWidth: 2 })?.width).toBe(15);
    expect(caretRect({ ...base, charWidth: 0 })?.width).toBe(7.5);
  });

  it('clamps a cursor past the last column (pending wrap) to the last cell', () => {
    expect(caretRect({ ...base, cursorX: 80 })?.left).toBe(79 * 7.5);
  });

  it('follows the viewport while scrolled back and gives up once the cursor is off screen', () => {
    expect(caretRect({ ...base, viewportY: 98 })?.top).toBe(4 * 18);
    expect(caretRect({ ...base, viewportY: 70 })).toBeNull();
  });

  it('gives up before the renderer has measured cells', () => {
    expect(caretRect({ ...base, cellWidth: Number.NaN })).toBeNull();
    expect(caretRect({ ...base, cellHeight: 0 })).toBeNull();
  });
});
