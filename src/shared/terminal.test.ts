import { describe, expect, it } from 'vitest';
import { MAX_TAB_TITLE_LENGTH, MAX_TAB_TITLES, sanitizeTabTitles } from './terminal';

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
