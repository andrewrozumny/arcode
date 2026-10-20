import { describe, expect, it } from 'vitest';
import type { ProjectEntry } from '@shared/app';
import { filterProjects, fuzzyScore, mergeProjects } from './fuzzy';

const project = (name: string, root: string, slug?: string): ProjectEntry =>
  slug ? { name, root, slug, source: 'registry' } : { name, root, source: 'recent' };

describe('fuzzyScore', () => {
  it('matches subsequences case-insensitively and rejects others', () => {
    expect(fuzzyScore('acd', 'ARcode')).not.toBeNull();
    expect(fuzzyScore('ACO', 'acode')).not.toBeNull();
    expect(fuzzyScore('xyz', 'acode')).toBeNull();
    expect(fuzzyScore('edoca', 'acode')).toBeNull();
  });

  it('prefers prefixes, contiguous runs and word starts', () => {
    const prefix = fuzzyScore('orb', 'orbit-console') ?? 0;
    const scattered = fuzzyScore('orb', 'other-rebuild') ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
    const wordStart = fuzzyScore('con', 'orbit-console') ?? 0;
    const inside = fuzzyScore('con', 'falcon') ?? 0;
    expect(wordStart).toBeGreaterThan(inside);
  });

  it('treats an empty query as a match', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('  ', 'anything')).toBe(0);
  });
});

describe('filterProjects', () => {
  const projects = [
    project('Ledger', '/Users/me/work/ledger', 'invoice-ocr'),
    project('Orbit Console', '/Users/me/code/orbit-console'),
    project('Mosaic', '/Users/me/code/Mosaic', 'mosaic'),
  ];

  it('keeps order for an empty query', () => {
    expect(filterProjects('', projects)).toEqual(projects);
  });

  it('matches by name, slug and path', () => {
    expect(filterProjects('orbit', projects)[0]?.name).toBe('Orbit Console');
    expect(filterProjects('invo', projects).map((p) => p.name)).toEqual(['Ledger']);
    expect(filterProjects('work', projects).map((p) => p.name)).toEqual(['Ledger']);
  });

  it('ranks the best match first', () => {
    expect(filterProjects('mos', projects)[0]?.name).toBe('Mosaic');
  });
});

describe('mergeProjects', () => {
  it('puts recent first and drops registry duplicates', () => {
    const recent = [project('A', '/a')];
    const registry = [project('A reg', '/a', 'a'), project('B', '/b', 'b')];
    expect(mergeProjects(recent, registry).map((p) => p.root)).toEqual(['/a', '/b']);
  });
});
