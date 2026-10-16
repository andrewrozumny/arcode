import { describe, expect, it } from 'vitest';
import type { LiveUsage } from '@shared/claude';
import { LIVE_MODEL_FRESH_MS, belongsToProject, headerUsage, pickBadgeModel, pickLiveUsage, pickPlanLimits } from './liveUsage';

function record(sessionId: string, cwd: string | null, updatedAt: number): LiveUsage {
  return { sessionId, cwd, modelId: null, modelName: null, contextUsed: null, contextSize: null, contextPercent: null, fiveHour: null, sevenDay: null, updatedAt };
}

describe('belongsToProject', () => {
  it('matches the root and folders inside it, not siblings with a shared prefix', () => {
    expect(belongsToProject('/work/app', '/work/app')).toBe(true);
    expect(belongsToProject('/work/app/src', '/work/app')).toBe(true);
    expect(belongsToProject('/work/app-two', '/work/app')).toBe(false);
    expect(belongsToProject(null, '/work/app')).toBe(false);
  });
});

describe('pickLiveUsage', () => {
  const records = [record('a', '/work/app', 10), record('b', '/work/app/sub', 20), record('c', '/other', 30)];

  it('prefers the active tab session', () => {
    expect(pickLiveUsage(records, 'a', '/work/app')?.sessionId).toBe('a');
  });

  it('falls back to the newest record inside the project', () => {
    expect(pickLiveUsage(records, 'missing', '/work/app')?.sessionId).toBe('b');
    expect(pickLiveUsage(records, null, '/work/app')?.sessionId).toBe('b');
  });

  it('returns null when nothing belongs to the project', () => {
    expect(pickLiveUsage(records, null, '/elsewhere')).toBeNull();
  });
});

describe('pickPlanLimits and headerUsage', () => {
  const win = (usedPercent: number, resetsAt: number | null) => ({ usedPercent, resetsAt });
  const withLimits = (r: LiveUsage, five: number, week: number, resetsAt = 10_000): LiveUsage => ({
    ...r,
    fiveHour: win(five, resetsAt),
    sevenDay: win(week, resetsAt),
  });

  it('prefers the current window and the highest usage over a fresher idle session', () => {
    const stale = { ...withLimits(record('idle', '/x', 900), 2, 1), fiveHour: win(2, 10_000) };
    const busy = withLimits(record('busy', '/y', 100), 10, 4);
    const older = { ...record('old', '/z', 950), fiveHour: win(50, 5_000), sevenDay: win(60, null) };
    expect(pickPlanLimits([stale, busy, older], 1_000)).toEqual({ fiveHour: win(10, 10_000), sevenDay: win(4, 10_000) });
  });

  it('takes the plan windows from a session that reported them, wherever it runs', () => {
    const records = [{ ...record('own', '/work/app', 50), contextPercent: 12 }, withLimits(record('other', '/other', 40), 30, 7)];
    expect(pickPlanLimits(records, 1_000)).toEqual({ fiveHour: win(30, 10_000), sevenDay: win(7, 10_000) });
    expect(headerUsage(records, 'own', '/work/app', 1_000)).toMatchObject({ sessionId: 'own', contextPercent: 12, fiveHour: { usedPercent: 30 } });
  });

  it('shows a window whose reset time has passed as 0%', () => {
    expect(pickPlanLimits([withLimits(record('a', '/x', 1), 80, 20, 500)], 1_000).fiveHour).toEqual({ usedPercent: 0, resetsAt: null });
  });

  it('shows plan windows even when no session of this project has reported', () => {
    const usage = headerUsage([withLimits(record('a', '/other', 5), 30, 7)], null, '/work/app', 1_000);
    expect(usage).toMatchObject({ sessionId: '', contextPercent: null, fiveHour: { usedPercent: 30 }, updatedAt: 5 });
    expect(headerUsage([record('a', '/other', 5)], null, '/work/app', 1_000)).toBeNull();
  });
});

describe('pickBadgeModel', () => {
  const transcript = { id: 'claude-fable-5-1', name: 'Fable 5.1' };
  const live: LiveUsage = { ...record('s1', '/work/app', 1_000), modelId: 'claude-opus-5-5', modelName: 'Opus 5.5' };

  it('prefers a fresh status line reading of the active session', () => {
    expect(pickBadgeModel(transcript, live, 's1', 1_000 + 5_000)).toEqual({ id: 'claude-opus-5-5', name: 'Opus 5.5' });
  });

  it('falls back to the transcript when the reading is stale, for another session, or has no model', () => {
    expect(pickBadgeModel(transcript, live, 's1', 1_000 + LIVE_MODEL_FRESH_MS + 1)).toBe(transcript);
    expect(pickBadgeModel(transcript, live, 'other', 2_000)).toBe(transcript);
    expect(pickBadgeModel(transcript, { ...live, modelId: null }, 's1', 2_000)).toBe(transcript);
    expect(pickBadgeModel(null, null, 's1', 2_000)).toBeNull();
  });
});
