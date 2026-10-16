import { describe, expect, it } from 'vitest';
import { pushHistory } from './history';

describe('pushHistory', () => {
  it('appends new entries', () => {
    expect(pushHistory(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('skips an immediate duplicate', () => {
    expect(pushHistory(['a', 'b'], 'b')).toEqual(['a', 'b']);
  });

  it('keeps only the newest entries', () => {
    const many = Array.from({ length: 50 }, (_, i) => String(i));
    const next = pushHistory(many, 'new');
    expect(next).toHaveLength(50);
    expect(next[0]).toBe('1');
    expect(next[49]).toBe('new');
  });
});
