import { describe, expect, it } from 'vitest';
import { pushHistory, searchHistory } from './history';

describe('pushHistory', () => {
  it('appends new entries', () => {
    expect(pushHistory(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('moves a repeated entry to the end instead of duplicating it', () => {
    expect(pushHistory(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
  });

  it('keeps only the newest entries', () => {
    const many = Array.from({ length: 200 }, (_, i) => String(i));
    const next = pushHistory(many, 'new');
    expect(next).toHaveLength(200);
    expect(next[0]).toBe('1');
    expect(next[199]).toBe('new');
  });
});

describe('searchHistory', () => {
  const history = ['run the gates', 'review the diff', 'Run tests and fix lint'];

  it('returns newest first for an empty query', () => {
    expect(searchHistory(history, '')).toEqual(['Run tests and fix lint', 'review the diff', 'run the gates']);
  });

  it('matches every word, ignoring case', () => {
    expect(searchHistory(history, 'run LINT')).toEqual(['Run tests and fix lint']);
  });

  it('caps the result', () => {
    expect(searchHistory(history, 'r', 2)).toHaveLength(2);
  });
});
