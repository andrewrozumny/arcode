import { useCallback, useEffect, useState } from 'react';
import type { LiveUsage, StatusLineState, UsageLimit, UsageSummary, UsageWindow } from '@shared/claude';
import { formatAge, formatCount, formatLocalTime } from '../format';
import { modelFamily } from '../layout/modelFamily';
import { claudeApi } from './api';
import { pickLiveUsage, useLiveUsage } from './liveUsage';
import { usePanel } from './panelData';
import { Meter, Notice } from './ui';
import { useLoad } from './useLoad';

const USAGE_REFRESH_MS = 30_000;

function UsageCard({ title, stats }: { title: string; stats: UsageWindow | null }) {
  if (!stats) {
    return (
      <div className="cl-card">
        <div className="cl-card-title">{title}</div>
        <div className="cl-desc">No session transcript yet.</div>
      </div>
    );
  }
  const rows: [string, number][] = [
    ['Messages', stats.messages],
    ['Input', stats.inputTokens],
    ['Output', stats.outputTokens],
    ['Cache read', stats.cacheReadTokens],
    ['Cache write', stats.cacheWriteTokens],
    ['Sessions', stats.sessions],
  ];
  return (
    <div className="cl-card">
      <div className="cl-card-title">{title}</div>
      <div className="cl-card-main">{formatCount(stats.inputTokens + stats.outputTokens)}</div>
      <div className="cl-card-sub">input + output tokens</div>
      <dl className="cl-stats">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{formatCount(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LimitCard({ limit }: { limit: UsageLimit }) {
  return (
    <div className="cl-card">
      <div className="cl-card-title">Plan limit</div>
      {limit.state === 'hit' && limit.hitAt ? (
        <>
          <div className="cl-card-main">Last limit hit</div>
          <div className="cl-card-sub">
            {formatLocalTime(limit.hitAt)}
            {limit.resetsAt ? `, resets ${formatLocalTime(limit.resetsAt)}` : ''}
          </div>
          {limit.rateLimitType && <div className="cl-desc">{limit.rateLimitType}</div>}
        </>
      ) : (
        <div className="cl-desc">No limit hit in the last 7 days.</div>
      )}
    </div>
  );
}

function windowValue(win: LiveUsage['fiveHour']): string {
  return win?.usedPercent == null ? 'n/a' : `${win.usedPercent}%`;
}

function windowReset(win: LiveUsage['fiveHour']): string | null {
  if (!win?.resetsAt) return null;
  return `resets ${new Date(win.resetsAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`;
}

function LiveCard({ title, win }: { title: string; win: LiveUsage['fiveHour'] }) {
  return (
    <div className="cl-card">
      <Meter label={title} percent={win?.usedPercent ?? null} value={windowValue(win)} sub={windowReset(win) ?? 'No data yet'} />
    </div>
  );
}

/**
 * Plan utilization straight from Claude Code's status line (the only place it is exposed), plus
 * the switch that points ~/.claude/settings.json at ARcode's script. The settings file changes only
 * through that switch.
 */
function LiveUsageSection({ root }: { root: string }) {
  const records = useLiveUsage();
  const live = pickLiveUsage(records, null, root);
  const panel = usePanel();
  const [state, setState] = useState<StatusLineState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshState = useCallback(() => {
    claudeApi()
      .statusLineState()
      .then(setState)
      .catch((err: unknown) => setMessage(String(err)));
  }, []);
  useEffect(refreshState, [refreshState]);

  const toggle = async (): Promise<void> => {
    if (!state || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = state.state === 'acode' ? await claudeApi().statusLineDisable() : await claudeApi().statusLineEnable();
      if (!result.ok) setMessage(result.reason);
      refreshState();
      panel.statusLine.reload();
    } catch (err: unknown) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  const age = live ? formatAge(new Date(live.updatedAt).toISOString()) : null;
  return (
    <>
      <div className="cl-cards three">
        <LiveCard title="5-hour window" win={live?.fiveHour ?? null} />
        <LiveCard title="Weekly window" win={live?.sevenDay ?? null} />
        <div className="cl-card">
          <Meter
            label="Context"
            percent={live?.contextPercent ?? null}
            value={live?.contextPercent != null ? `${live.contextPercent}%` : 'n/a'}
            sub={
              live?.contextUsed != null
                ? `${formatCount(live.contextUsed)}${live.contextSize ? ` of ${formatCount(live.contextSize)}` : ''} tokens`
                : 'No data yet'
            }
          />
          {live && (
            <div className="cl-card-sub">
              <span className={live.modelName ? `model-family-${modelFamily(live.modelName)}` : undefined}>
                {live.modelName ?? 'unknown model'}
              </span>
              {age ? ` · ${age}` : ''}
            </div>
          )}
        </div>
      </div>
      <div className="cl-toolbar">
        <span className="cl-desc cl-grow">
          Plan limits come from the Claude Code status line, the only place Claude Code exposes them.
          {state?.state === 'other' && ` Another status line is configured (${state.command ?? ''}); ARcode leaves it alone.`}
          {state?.state === 'off' && ' Turn it on to see 5-hour and weekly usage here and in the header.'}
          {state?.state === 'acode' && !live && ' Numbers appear after the next reply from a Claude session in this project.'}
        </span>
        <button
          type="button"
          className={state?.state === 'acode' ? 'cl-btn' : 'cl-btn primary'}
          disabled={busy || !state || state.state === 'other'}
          title={state?.state === 'other' ? state.command ?? '' : 'Writes statusLine into ~/.claude/settings.json (backup kept)'}
          onClick={() => void toggle()}
        >
          {state?.state === 'acode' ? 'Status line: on' : state?.state === 'other' ? 'Status line: other' : 'Status line: off'}
        </button>
      </div>
      {message && <Notice>{message}</Notice>}
    </>
  );
}

export function UsageView({ root }: { root: string }) {
  const { data, error, loading, reload } = useLoad<UsageSummary>(() => claudeApi().usage(root), true);
  useEffect(() => {
    const timer = window.setInterval(reload, USAGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);
  return (
    <>
      <LiveUsageSection root={root} />
      <div className="cl-toolbar">
        <h3 className="cl-group-title cl-grow">Tokens from transcripts</h3>
        <span className="cl-toolbar-note">Refreshes every 30 s</span>
        <button type="button" className="cl-btn" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      {data && (
        <>
          <div className="cl-cards">
            <UsageCard title="Current session" stats={data.currentSession} />
            <UsageCard title="Today" stats={data.today} />
            <UsageCard title="Last 7 days" stats={data.last7Days} />
            <LimitCard limit={data.limit} />
          </div>
          <Notice>{data.limitsNote}</Notice>
        </>
      )}
    </>
  );
}
