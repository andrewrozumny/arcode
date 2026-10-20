import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_FILES,
  MAX_VIEWER_TABS,
  isProjectRelative,
  sanitizeRecentFiles,
  sanitizeViewerTabs,
  updateRecentFiles,
} from './editorState';

describe('isProjectRelative', () => {
  it('accepts plain relative paths and refuses escapes and odd shapes', () => {
    expect(isProjectRelative('src/a.ts')).toBe(true);
    expect(isProjectRelative('README.md')).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b', 5, null]) {
      expect(isProjectRelative(bad)).toBe(false);
    }
  });
});

describe('updateRecentFiles', () => {
  it('moves the path to the front without duplicates', () => {
    expect(updateRecentFiles([], 'a')).toEqual(['a']);
    expect(updateRecentFiles(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(updateRecentFiles(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  it('caps the list, dropping the oldest', () => {
    const full = Array.from({ length: MAX_RECENT_FILES }, (_v, i) => `f${i}`);
    const next = updateRecentFiles(full, 'new');
    expect(next).toHaveLength(MAX_RECENT_FILES);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`f${MAX_RECENT_FILES - 1}`);
    expect(updateRecentFiles(['a', 'b', 'c'], 'd', 2)).toEqual(['d', 'a']);
  });
});

describe('sanitizeRecentFiles', () => {
  it('keeps valid unique paths in order and caps them', () => {
    expect(sanitizeRecentFiles(['a', 'a', '../x', 3, 'b'])).toEqual(['a', 'b']);
    expect(sanitizeRecentFiles('nope')).toEqual([]);
    const many = Array.from({ length: MAX_RECENT_FILES + 5 }, (_v, i) => `f${i}`);
    expect(sanitizeRecentFiles(many)).toHaveLength(MAX_RECENT_FILES);
  });
});

describe('sanitizeViewerTabs', () => {
  it('rejects non-objects', () => {
    expect(sanitizeViewerTabs(null)).toBeUndefined();
    expect(sanitizeViewerTabs(['a'])).toBeUndefined();
  });

  it('cleans files and keeps the active tab only when it is one of them', () => {
    expect(sanitizeViewerTabs({ files: ['a', '/abs', 'a', 'b'], active: 'b' })).toEqual({
      files: ['a', 'b'],
      active: 'b',
    });
    expect(sanitizeViewerTabs({ files: ['a'], active: 'gone' })).toEqual({ files: ['a'], active: null });
    expect(sanitizeViewerTabs({ files: 'x', active: 7 })).toEqual({ files: [], active: null });
  });

  it('caps the number of tabs', () => {
    const files = Array.from({ length: MAX_VIEWER_TABS + 10 }, (_v, i) => `f${i}`);
    expect(sanitizeViewerTabs({ files, active: null })?.files).toHaveLength(MAX_VIEWER_TABS);
  });
});
