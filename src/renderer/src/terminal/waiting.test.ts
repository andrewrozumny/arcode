import { describe, expect, it } from 'vitest';
import { nextWaitingTab, tabTitlesOf } from './waiting';

const tab = (id: string, waiting = false) => ({ id, claudeStatus: waiting ? ('waiting' as const) : ('busy' as const) });

describe('nextWaitingTab', () => {
  it('returns null when no tab waits', () => {
    expect(nextWaitingTab([], null)).toBeNull();
    expect(nextWaitingTab([tab('a'), tab('b')], 'a')).toBeNull();
  });

  it('picks the first waiting tab after the active one', () => {
    const tabs = [tab('a', true), tab('b'), tab('c', true), tab('d', true)];
    expect(nextWaitingTab(tabs, 'b')).toBe('c');
    expect(nextWaitingTab(tabs, 'c')).toBe('d');
  });

  it('wraps around to the start of the strip', () => {
    const tabs = [tab('a', true), tab('b'), tab('c', true)];
    expect(nextWaitingTab(tabs, 'c')).toBe('a');
  });

  it('cycles through every waiting tab with repeated jumps', () => {
    const tabs = [tab('a'), tab('b', true), tab('c'), tab('d', true), tab('e', true)];
    const visited: string[] = [];
    let active: string | null = 'a';
    for (let i = 0; i < 4; i++) {
      active = nextWaitingTab(tabs, active);
      visited.push(active ?? '-');
    }
    expect(visited).toEqual(['b', 'd', 'e', 'b']);
  });

  it('returns the active tab when it is the only one waiting', () => {
    expect(nextWaitingTab([tab('a'), tab('b', true)], 'b')).toBe('b');
  });

  it('starts from the first tab when the active id is unknown or null', () => {
    const tabs = [tab('a', true), tab('b', true)];
    expect(nextWaitingTab(tabs, null)).toBe('a');
    expect(nextWaitingTab(tabs, 'gone')).toBe('a');
  });

  it('ignores idle, busy and unknown tabs', () => {
    const tabs = [
      { id: 'a', claudeStatus: 'idle' as const },
      { id: 'b', claudeStatus: undefined },
      { id: 'c', claudeStatus: 'waiting' as const },
    ];
    expect(nextWaitingTab(tabs, 'a')).toBe('c');
  });
});

describe('tabTitlesOf', () => {
  it('lists the tabs that own a pty', () => {
    expect(
      tabTitlesOf([
        { ptyId: 3, title: 'Claude' },
        { title: 'Shell' },
        { ptyId: 7, title: 'Review' },
      ]),
    ).toEqual([
      { ptyId: 3, title: 'Claude' },
      { ptyId: 7, title: 'Review' },
    ]);
  });
});
