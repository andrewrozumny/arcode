import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DELAY_MS, canAutosave, debounced, isTypeToEditKey } from './autosave';

afterEach(() => {
  vi.useRealTimers();
});

describe('canAutosave', () => {
  it('saves only when enabled, dirty and no banner waits for a decision', () => {
    expect(canAutosave({ enabled: true, dirty: true, banner: false })).toBe(true);
    expect(canAutosave({ enabled: false, dirty: true, banner: false })).toBe(false);
    expect(canAutosave({ enabled: true, dirty: false, banner: false })).toBe(false);
    expect(canAutosave({ enabled: true, dirty: true, banner: true })).toBe(false);
  });
});

describe('debounced', () => {
  it('runs once after the last schedule', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = debounced(run, AUTOSAVE_DELAY_MS);
    d.schedule();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    d.schedule();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(false);
  });

  it('flushes a pending run at once and only once', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = debounced(run, 1000);
    expect(d.flush()).toBe(false);
    d.schedule();
    expect(d.flush()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancel drops a pending run', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = debounced(run, 1000);
    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('isTypeToEditKey', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; isComposing: boolean }> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    ...mods,
  });

  it('accepts printable characters, space and Option characters', () => {
    for (const k of ['a', 'Z', '1', ';', ' ', 'Ж', '€', 'å', '😀']) expect(isTypeToEditKey(key(k))).toBe(true);
  });

  it('refuses shortcuts, named keys and composition', () => {
    expect(isTypeToEditKey(key('c', { metaKey: true }))).toBe(false);
    expect(isTypeToEditKey(key('a', { ctrlKey: true }))).toBe(false);
    expect(isTypeToEditKey(key('a', { isComposing: true }))).toBe(false);
    for (const k of ['Enter', 'ArrowUp', 'Backspace', 'Tab', 'Escape', 'Dead', 'Shift', '\u007f', '\t']) {
      expect(isTypeToEditKey(key(k))).toBe(false);
    }
  });
});
