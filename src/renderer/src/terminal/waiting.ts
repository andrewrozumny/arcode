/** Pure helpers for tabs where Claude waits for the user: jump order and the titles main names in notifications. */
import type { TabTitle } from '@shared/terminal';
import type { TerminalTab } from './types';

type TabLike = Pick<TerminalTab, 'id' | 'claudeStatus'>;

/**
 * The waiting tab to jump to: the first one after the active tab in strip order, wrapping
 * around, so repeated jumps cycle through all of them. When the active tab is the only waiting
 * one it is returned again (the jump refocuses it); null when no tab waits.
 */
export function nextWaitingTab(tabs: readonly TabLike[], activeId: string | null): string | null {
  const count = tabs.length;
  if (count === 0) return null;
  const start = tabs.findIndex((t) => t.id === activeId);
  for (let step = 1; step <= count; step++) {
    const tab = tabs[(start + step + count) % count];
    if (tab?.claudeStatus === 'waiting') return tab.id;
  }
  return null;
}

/** Titles of the tabs that own a pty, in strip order. */
export function tabTitlesOf(tabs: readonly Pick<TerminalTab, 'ptyId' | 'title'>[]): TabTitle[] {
  const titles: TabTitle[] = [];
  for (const tab of tabs) if (tab.ptyId !== undefined) titles.push({ ptyId: tab.ptyId, title: tab.title });
  return titles;
}
