import { describe, expect, it } from 'vitest';
import type { SubagentInfo } from '@shared/claude';
import { shortAge } from '../format';
import { runningAgents, sameList } from './subagents';

const agent = (id: string, running: boolean, model: string | null = 'claude-opus-5-5'): SubagentInfo => ({
  id,
  label: id,
  agentType: 'fork',
  model,
  modelName: null,
  startedAt: '2026-10-09T10:00:00.000Z',
  lastActivityAt: '2026-10-09T10:01:00.000Z',
  running,
});

describe('subagent helpers', () => {
  it('compares lists by the fields the header shows', () => {
    expect(sameList([agent('a', true)], [agent('a', true)])).toBe(true);
    expect(sameList([agent('a', true)], [agent('a', false)])).toBe(false);
    expect(sameList([agent('a', true)], [agent('a', true, 'claude-haiku-5-5')])).toBe(false);
    expect(sameList([], [agent('a', true)])).toBe(false);
  });

  it('keeps only running agents for the chip', () => {
    expect(runningAgents([agent('a', true), agent('b', false)]).map((a) => a.id)).toEqual(['a']);
  });

  it('formats short ages', () => {
    const now = Date.parse('2026-10-09T10:10:00.000Z');
    expect(shortAge('2026-10-09T10:09:30.000Z', now)).toBe('30s');
    expect(shortAge('2026-10-09T10:07:00.000Z', now)).toBe('3m');
    expect(shortAge('2026-10-09T08:00:00.000Z', now)).toBe('2h');
    expect(shortAge(null, now)).toBe('');
  });
});
