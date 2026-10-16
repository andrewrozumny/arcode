import { describe, expect, it } from 'vitest';
import { parseHome, registryEntries } from './registry';

const HOME = '/Users/me';

describe('parseHome', () => {
  it('expands ~ and drops notes after a middle dot', () => {
    expect(parseHome('~/work/app · notes.md = main doc', HOME)).toBe('/Users/me/work/app');
    expect(parseHome('~/work/app·notes', HOME)).toBe('/Users/me/work/app');
  });

  it('drops notes in parentheses, attached or separated', () => {
    expect(parseHome('~/work/app (Swift + chrome/)', HOME)).toBe('/Users/me/work/app');
    expect(parseHome('~/work/app(draft)', HOME)).toBe('/Users/me/work/app');
  });

  it('keeps absolute paths and strips trailing slashes and punctuation', () => {
    expect(parseHome('/srv/www/site/', HOME)).toBe('/srv/www/site');
    expect(parseHome('~/work/app, see docs', HOME)).toBe('/Users/me/work/app');
    expect(parseHome('~', HOME)).toBe('/Users/me');
    expect(parseHome('  ~/a/b  ', HOME)).toBe('/Users/me/a/b');
  });

  it('rejects values that are not paths', () => {
    expect(parseHome('nowhere yet', HOME)).toBeNull();
    expect(parseHome('—', HOME)).toBeNull();
    expect(parseHome('', HOME)).toBeNull();
    expect(parseHome('example.com (SaaS)', HOME)).toBeNull();
    expect(parseHome('~user/x', HOME)).toBeNull();
  });
});

describe('registryEntries', () => {
  const existing = new Set(['/Users/me/a', '/Users/me/b', '/Users/me/c', '/Users/me/d']);
  const exists = (path: string): boolean => existing.has(path);

  it('keeps existing folders only, priority statuses first, then by name', () => {
    const entries = registryEntries(
      [
        { slug: 'zeta', name: 'Zeta', status: 'paused', kind: 'own', home: '~/a' },
        { slug: 'beta', name: 'Beta', status: 'active', kind: 'client', home: '~/b · tracker' },
        { slug: 'gone', name: 'Gone', status: 'active', home: '~/missing' },
        { slug: 'alpha', name: 'Alpha', status: 'validating', home: '~/c' },
        { slug: 'nopath', name: 'No path', status: 'active', home: 'somewhere' },
        { slug: 'archived', name: 'Archived', status: 'archived', home: '~/d' },
        { slug: 'dup', name: 'Duplicate', status: 'active', home: '~/a (copy)' },
        { slug: 'null-home', name: 'Null', status: 'active', home: null },
      ],
      { homeDir: HOME, exists },
    );
    expect(entries.map((e) => e.slug)).toEqual(['alpha', 'beta', 'archived', 'zeta']);
    expect(entries[1]).toEqual({
      root: '/Users/me/b',
      name: 'Beta',
      slug: 'beta',
      status: 'active',
      kind: 'client',
      source: 'registry',
    });
  });

  it('falls back to slug when the name is empty', () => {
    const [entry] = registryEntries([{ slug: 'x', name: '', home: '~/a' }], { homeDir: HOME, exists });
    expect(entry?.name).toBe('x');
  });
});
