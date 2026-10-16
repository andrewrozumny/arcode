import { useEffect, useState } from 'react';
import type { LiveUsage, LiveUsageWindow } from '@shared/claude';

/** True when a session's working directory is the project folder or inside it. */
export function belongsToProject(cwd: string | null, projectRoot: string): boolean {
  if (!cwd) return false;
  return cwd === projectRoot || cwd.startsWith(projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`);
}

/**
 * The record the header shows: the active Claude tab's session when it has reported, otherwise
 * the newest record of a session running inside this project. Null when nothing applies.
 */
export function pickLiveUsage(
  records: readonly LiveUsage[],
  activeSessionId: string | null,
  projectRoot: string,
): LiveUsage | null {
  if (activeSessionId) {
    const own = records.find((r) => r.sessionId === activeSessionId);
    if (own) return own;
  }
  let newest: LiveUsage | null = null;
  for (const record of records) {
    if (!belongsToProject(record.cwd, projectRoot)) continue;
    if (!newest || record.updatedAt > newest.updatedAt) newest = record;
  }
  return newest;
}

/**
 * Plan windows are per account, not per session, but a session reports them only after its first
 * API response, and an idle session keeps repeating its old figures. So for each window the header
 * takes the current window (latest reset time) and, among sessions that reported it, the highest
 * usage, which only grows within a window. When every reported window has expired it shows 0%
 * until a session reports the new one.
 */
export function pickPlanLimits(
  records: readonly LiveUsage[],
  now: number,
): Pick<LiveUsage, 'fiveHour' | 'sevenDay'> {
  const pick = (key: 'fiveHour' | 'sevenDay'): LiveUsage[typeof key] => {
    let best: LiveUsageWindow | null = null;
    let expired = false;
    for (const record of records) {
      const win = record[key];
      if (win?.usedPercent == null) continue;
      if (win.resetsAt !== null && win.resetsAt <= now) {
        expired = true;
        continue;
      }
      if (!best || isBetterWindow(win, best)) best = win;
    }
    return best ?? (expired ? { usedPercent: 0, resetsAt: null } : null);
  };
  return { fiveHour: pick('fiveHour'), sevenDay: pick('sevenDay') };
}

/** Later reset first (a window without a reset time ranks last), then higher usage. */
function isBetterWindow(a: LiveUsageWindow, b: LiveUsageWindow): boolean {
  if (a.resetsAt !== b.resetsAt) return b.resetsAt === null || (a.resetsAt !== null && a.resetsAt > b.resetsAt);
  return (a.usedPercent ?? 0) > (b.usedPercent ?? 0);
}

/**
 * Header record: context and model of the session `pickLiveUsage` chose, plan windows from
 * `pickPlanLimits`. Without a session of this project only the plan windows are shown.
 */
export function headerUsage(
  records: readonly LiveUsage[],
  activeSessionId: string | null,
  projectRoot: string,
  now: number,
): LiveUsage | null {
  const session = pickLiveUsage(records, activeSessionId, projectRoot);
  const limits = pickPlanLimits(records, now);
  if (session) return { ...session, ...limits };
  if (!limits.fiveHour && !limits.sevenDay) return null;
  // Age of the plan figures: the newest record that carried any of them.
  const updatedAt = Math.max(0, ...records.filter((r) => r.fiveHour || r.sevenDay).map((r) => r.updatedAt));
  return {
    sessionId: '',
    cwd: null,
    modelId: null,
    modelName: null,
    contextUsed: null,
    contextSize: null,
    contextPercent: null,
    ...limits,
    updatedAt,
  };
}

/** How long a status line model reading stays authoritative over the transcript. */
export const LIVE_MODEL_FRESH_MS = 10 * 60 * 1000;

/** Model shown in the header badge. */
export interface BadgeModel {
  /** Model id, e.g. `claude-opus-5-5`. */
  id: string;
  /** Marketing name written by Claude Code on a `/model` switch, e.g. `Opus 5.5`. */
  name: string | null;
}

/**
 * Model for the header badge. The status line reruns right after `/model`, while the transcript
 * records the switch only with the next prompt, so a fresh status line reading of the active
 * session wins; otherwise the transcript-derived model is used.
 */
export function pickBadgeModel(
  transcript: BadgeModel | null,
  live: LiveUsage | null,
  activeSessionId: string | null,
  now: number,
): BadgeModel | null {
  if (
    live &&
    activeSessionId &&
    live.sessionId === activeSessionId &&
    live.modelId &&
    now - live.updatedAt <= LIVE_MODEL_FRESH_MS
  ) {
    return { id: live.modelId, name: live.modelName };
  }
  return transcript;
}

/** Live usage records of all sessions, kept current from the main process. */
export function useLiveUsage(): LiveUsage[] {
  const [records, setRecords] = useState<LiveUsage[]>([]);
  useEffect(() => {
    const api = window.acode?.claude;
    if (!api) return;
    const off = api.onUsageLive(setRecords);
    void api.usageLive().then(setRecords).catch(() => undefined);
    return off;
  }, []);
  return records;
}
