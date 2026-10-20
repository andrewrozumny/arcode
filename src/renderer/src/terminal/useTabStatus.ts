import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeStatusEvent } from '@shared/terminal';
import { terminalApi } from './api';
import type { TerminalTab } from './types';
import { tabTitlesOf } from './waiting';

/** Applies Claude status events from the main process (and the snapshot on mount) to the matching tab. */
export function useClaudeStatus(
  tabsRef: { readonly current: readonly TerminalTab[] },
  patchTab: (id: string, patch: Partial<TerminalTab>) => void,
): void {
  useEffect(() => {
    const apply = (event: ClaudeStatusEvent): void => {
      const tab = tabsRef.current.find(
        (t) =>
          (event.ptyId !== null && t.ptyId === event.ptyId) ||
          (event.sessionId !== null && t.claude?.sessionId === event.sessionId),
      );
      if (!tab) return;
      if (event.status === 'ended') {
        patchTab(tab.id, { claudeStatus: undefined, waitingFor: undefined, claudeModel: undefined, claudeModelName: undefined });
      } else {
        patchTab(tab.id, {
          claudeStatus: event.status,
          waitingFor: event.waitingFor ?? undefined,
          claudeModel: event.model ?? undefined,
          claudeModelName: event.modelName ?? undefined,
        });
      }
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
