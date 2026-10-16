import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TerminalTab } from '../terminal/types';
import { headerUsage, pickBadgeModel, useLiveUsage } from './liveUsage';
import type { BadgeModel } from './liveUsage';
import { runningAgents, useSubagents } from './subagents';

/**
 * What the window header shows about Claude: the active tab's model, its plan usage and its running
 * subagents, plus the session the Claude feed tab shows. Feed it the terminal's tab changes
 * through `onTabsChange`.
 */
export function useHeaderClaude(projectRoot: string) {
  const liveUsage = useLiveUsage();
  const [claudeModel, setClaudeModel] = useState<BadgeModel | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [feedSessionId, setFeedSessionId] = useState<string | null>(null);
  const subagents = useSubagents(activeSessionId);
  const running = useMemo(() => runningAgents(subagents), [subagents]);

  // Model of the active Claude tab in this window's terminal; hidden for shells and gates.
  const onTabsChange = useCallback((tabs: readonly TerminalTab[], activeTabId: string | null) => {
    const active = tabs.find((t) => t.id === activeTabId);
    setClaudeModel((prev) => {
      const next = active?.kind === 'claude' && active.claudeModel
        ? { id: active.claudeModel, name: active.claudeModelName ?? null }
        : null;
      return prev?.id === next?.id && prev?.name === next?.name ? prev : next;
    });
    const activeSession = active?.kind === 'claude' ? (active.claude?.sessionId ?? null) : null;
    setActiveSessionId(activeSession);
    // The feed follows the active Claude tab and keeps the last session while a shell or gate tab
    // is active; before any Claude tab was active it picks the newest Claude tab with a session.
    setFeedSessionId((prev) => {
      if (activeSession) return activeSession;
      if (prev) return prev;
      const claudeTabs = tabs.filter((t) => t.kind === 'claude' && t.claude?.sessionId);
      return claudeTabs[claudeTabs.length - 1]?.claude?.sessionId ?? null;
    });
  }, []);

  // The status line reruns right after /model, the transcript only with the next prompt: a fresh
  // status line reading wins. The clock ticks so a stale reading hands back to the transcript and a
  // plan window that has reset drops to 0%.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Context of the active tab's session (else the newest one in this project); plan windows from
  // whichever session reported them last, since they belong to the account.
  const usage = useMemo(
    () => headerUsage(liveUsage, activeSessionId, projectRoot, clock),
    [liveUsage, activeSessionId, projectRoot, clock],
  );

  const badgeModel = useMemo(
    () => pickBadgeModel(claudeModel, usage, activeSessionId, Math.max(clock, usage?.updatedAt ?? 0)),
    [claudeModel, usage, activeSessionId, clock],
  );

  return { onTabsChange, usage, badgeModel, running, feedSessionId };
}
