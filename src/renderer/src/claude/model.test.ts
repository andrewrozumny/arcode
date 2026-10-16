import { describe, expect, it } from 'vitest';
import type { ConfigScope } from '@shared/claude';
import { formatAge, formatCount } from '../format';
import { SCOPE_LABELS, groupByScope, matchesQuery, mcpBadge } from './model';

describe('matchesQuery', () => {
  it('matches any field case-insensitively and ignores blanks', () => {
    expect(matchesQuery(['Deploy Helper', null], 'helper')).toBe(true);
    expect(matchesQuery([null, 'desc with TYPESCRIPT'], ' typescript ')).toBe(true);
    expect(matchesQuery(['a', undefined], 'zzz')).toBe(false);
    expect(matchesQuery([], '   ')).toBe(true);
  });
});

describe('groupByScope', () => {
  it('orders groups project, local, user, plugin, claudeai and keeps input order inside', () => {
    const items: { name: string; scope: ConfigScope }[] = [
      { name: 'p1', scope: 'plugin' },
      { name: 'u1', scope: 'user' },
      { name: 'x1', scope: 'project' },
      { name: 'u2', scope: 'user' },
      { name: 'c1', scope: 'claudeai' },
    ];
    const groups = groupByScope(items);
    expect(groups.map((g) => g.scope)).toEqual(['project', 'user', 'plugin', 'claudeai']);
    expect(groups[1]?.items.map((i) => i.name)).toEqual(['u1', 'u2']);
    expect(groups[0]?.label).toBe(SCOPE_LABELS.project);
  });

  it('returns no groups for an empty list', () => {
    expect(groupByScope([])).toEqual([]);
  });
});

describe('formatCount', () => {
  it('formats token counts compactly', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(987)).toBe('987');
    expect(formatCount(1200)).toBe('1.2k');
    expect(formatCount(45_000)).toBe('45k');
    expect(formatCount(1_000)).toBe('1k');
    expect(formatCount(3_400_000)).toBe('3.4M');
    expect(formatCount(1_100_000_000)).toBe('1.1B');
    expect(formatCount(Number.NaN)).toBe('0');
  });
});

describe('mcpBadge', () => {
  it('maps every state to a label and tone', () => {
    expect(mcpBadge('connected')).toEqual({ label: 'Connected', tone: 'ok' });
    expect(mcpBadge('needs-auth')).toEqual({ label: 'Needs auth', tone: 'warn' });
    expect(mcpBadge('failed')).toEqual({ label: 'Failed', tone: 'error' });
    expect(mcpBadge('disabled')).toEqual({ label: 'Disabled', tone: 'muted' });
    expect(mcpBadge('unknown')).toEqual({ label: 'Unknown', tone: 'neutral' });
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it('describes minutes, hours and days', () => {
    expect(formatAge('2026-10-09T11:59:40Z', now)).toBe('just now');
    expect(formatAge('2026-10-09T11:55:00Z', now)).toBe('5 min ago');
    expect(formatAge('2026-10-09T09:00:00Z', now)).toBe('3 h ago');
    expect(formatAge('2026-10-05T12:00:00Z', now)).toBe('4 d ago');
    expect(formatAge(null, now)).toBe('');
    expect(formatAge('not a date', now)).toBe('');
  });
});
