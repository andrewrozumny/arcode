import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeStatusEvent } from '@shared/terminal';
import { terminalApi } from './api';
import type { TerminalTab } from './types';
import { tabTitlesOf } from './waiting';

/**
 * The tab a status event belongs to: the one whose pty started the process, else the one that
 * already shows the session (a process started outside this window's shells, matched by id).
 */
export function tabOfStatus(tabs: readonly TerminalTab[], event: ClaudeStatusEvent): TerminalTab | undefined {
  const own = event.ptyId !== null ? tabs.find((t) => t.ptyId === event.ptyId) : undefined;
  return own ?? (event.sessionId !== null ? tabs.find((t) => t.claude?.sessionId === event.sessionId) : undefined);
}

/**
 * What a status event changes on its tab. A `claude` started by hand is followed like one the tab
 * started itself: a Claude tab whose previous process was quit takes the new session id, and a
 * shell tab becomes a Claude tab, so the feed, the header and resume on restart follow the
 * process that actually runs there.
 */
export function claudeStatusPatch(tab: TerminalTab, event: ClaudeStatusEvent): Partial<TerminalTab> {
  if (event.status === 'ended') {
    return { claudeStatus: undefined, waitingFor: undefined, claudeModel: undefined, claudeModelName: undefined, remoteControl: undefined };
  }
  const patch: Partial<TerminalTab> = {
    claudeStatus: event.status,
    waitingFor: event.waitingFor ?? undefined,
    claudeModel: event.model ?? undefined,
    claudeModelName: event.modelName ?? undefined,
    remoteControl: event.remoteControl ?? undefined,
  };
  const ownPty = event.ptyId !== null && tab.ptyId === event.ptyId;
  if (!ownPty || !event.sessionId) return patch;
  if (tab.claude) {
    if (tab.claude.sessionId !== event.sessionId) patch.claude = { ...tab.claude, sessionId: event.sessionId, resumed: false };
  } else if (tab.kind === 'shell') {
    const name = event.name ?? tab.title;
    patch.kind = 'claude';
    patch.title = name;
    patch.claude = { sessionId: event.sessionId, name, resumed: false };
  }
  return patch;
}

/** Applies Claude status events from the main process (and the snapshot on mount) to the matching tab. */
export function useClaudeStatus(
  tabsRef: { readonly current: readonly TerminalTab[] },
  patchTab: (id: string, patch: Partial<TerminalTab>) => void,
): void {
  useEffect(() => {
    const apply = (event: ClaudeStatusEvent): void => {
      const tab = tabOfStatus(tabsRef.current, event);
      if (tab) patchTab(tab.id, claudeStatusPatch(tab, event));
    };
    const off = terminalApi().onClaudeStatus(apply);
    void terminalApi()
      .claudeSnapshot()
      .then((events) => events.forEach(apply))
      .catch(() => undefined);
    return off;
  }, [patchTab, tabsRef]);
}

/**
 * Tells main how many tabs wait for the user and are not being looked at, for the dock badge.
 * The visible tabs of a focused window (the active tab of each dock column) do not count.
 */
export function useAttentionBadge(tabs: readonly TerminalTab[], visibleIds: readonly (string | null)[]): void {
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = (): void => setWindowFocused(true);
    const onBlur = (): void => setWindowFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const visibleKey = visibleIds.join('\n');
  const waitingCount = useMemo(() => {
    const visible = new Set(visibleKey.split('\n'));
    return tabs.filter((t) => t.claudeStatus === 'waiting' && !(visible.has(t.id) && windowFocused)).length;
  }, [tabs, visibleKey, windowFocused]);
  useEffect(() => {
    terminalApi().attention({ waiting: waitingCount });
  }, [waitingCount]);
}

/** Tells main the title of every tab that has a pty, so a "Claude is waiting" notification can name the tab. */
export function useTabTitlesReport(tabs: readonly TerminalTab[]): void {
  const last = useRef('');
  useEffect(() => {
    const titles = tabTitlesOf(tabs);
    const json = JSON.stringify(titles);
    if (json === last.current) return;
    last.current = json;
    terminalApi().tabTitles(titles);
  }, [tabs]);
}
