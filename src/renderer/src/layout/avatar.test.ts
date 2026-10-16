import { describe, expect, it } from 'vitest';
import { avatarColor, initials } from './avatar';

describe('initials', () => {
  it('takes the first letters of the first two words', () => {
    expect(initials('orbit-console')).toBe('OC');
    expect(initials('my_project.web')).toBe('MP');
    expect(initials('Hello World again')).toBe('HW');
  });

  it('uses two letters of a single word and a fallback for empty names', () => {
    expect(initials('acode')).toBe('AC');
    expect(initials('x')).toBe('X');
    expect(initials('')).toBe('?');
    expect(initials('---')).toBe('?');
  });
});

describe('avatarColor', () => {
  it('is deterministic and returns a hex colour', () => {
    expect(avatarColor('orbit-console')).toBe(avatarColor('orbit-console'));
    expect(avatarColor('ledger')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('spreads different names over the palette', () => {
    const names = ['acode', 'ledger', 'orbit-api', 'docs-site', 'notes', 'pipeline', 'mosaic'];
    expect(new Set(names.map(avatarColor)).size).toBeGreaterThan(2);
  });
});
