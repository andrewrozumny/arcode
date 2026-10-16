import { describe, expect, it } from 'vitest';
import { ownedByWindow, WaitingTransitions } from './notifications';

describe('WaitingTransitions', () => {
  it('reports only the step into waiting', () => {
    const t = new WaitingTransitions();
    expect(t.observe({ pid: 1, status: 'busy' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'busy' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
  });

  it('tracks processes separately', () => {
    const t = new WaitingTransitions();
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
    expect(t.observe({ pid: 2, status: 'waiting' })).toBe(true);
  });

  it('forgets a process that ended, so its next waiting period notifies again', () => {
    const t = new WaitingTransitions();
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
    expect(t.observe({ pid: 1, status: 'ended' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
  });
});

describe('ownedByWindow', () => {
  it('accepts only processes started from one of the window ptys', () => {
    expect(ownedByWindow({ ptyId: 3 })).toBe(true);
    expect(ownedByWindow({ ptyId: null })).toBe(false);
  });
});
