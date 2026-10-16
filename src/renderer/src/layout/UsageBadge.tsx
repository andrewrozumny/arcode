import { useEffect, useState } from 'react';
import type { LiveUsage } from '@shared/claude';
import { formatTokens } from '../format';

/** Badge tone for a percentage: amber from 70, red from 90. */
export function usageTone(percent: number | null): 'muted' | 'warn' | 'danger' {
  if (percent === null) return 'muted';
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'muted';
}

function resetText(label: string, win: LiveUsage['fiveHour']): string | null {
  if (!win || win.usedPercent === null) return null;
  const when = win.resetsAt ? new Date(win.resetsAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '?';
  return `${label}: ${win.usedPercent}% used, resets ${when}`;
}

/** Wall clock that ticks every few seconds, for "updated N s ago" without reading the clock in render. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** One labelled mini bar; the percentage shows on hover of the whole group. */
function UsageBar({ label, percent }: { label: string; percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span className={`usage-bar ${usageTone(percent)}`}>
      <span className="usage-bar-label">{label}</span>
      <span className="usage-bar-track" aria-hidden="true">
        <span className="usage-bar-fill" style={{ width: `${clamped}%` }} />
      </span>
      <span className="usage-bar-value">{percent}%</span>
    </span>
  );
}

/** Context fill first (it moves the most), then the 5-hour and weekly plan windows, as mini bars. */
export function UsageBadge({ usage }: { usage: LiveUsage }) {
  const now = useNow(5000);
  const bars: { label: string; percent: number }[] = [];
  const contextPercent =
    usage.contextPercent ??
    (usage.contextUsed !== null && usage.contextSize ? Math.round((usage.contextUsed / usage.contextSize) * 100) : null);
  if (contextPercent !== null) bars.push({ label: 'ctx', percent: contextPercent });
  if (usage.fiveHour?.usedPercent != null) bars.push({ label: '5h', percent: usage.fiveHour.usedPercent });
  if (usage.sevenDay?.usedPercent != null) bars.push({ label: 'wk', percent: usage.sevenDay.usedPercent });
  if (bars.length === 0) return null;
  const age = Math.max(0, Math.round((now - usage.updatedAt) / 1000));
  const title = [
    usage.contextUsed !== null
      ? `Context: ${formatTokens(usage.contextUsed)} of ${usage.contextSize ? formatTokens(usage.contextSize) : '?'} tokens (${usage.contextUsed.toLocaleString()})`
      : null,
    resetText('5-hour window', usage.fiveHour),
    resetText('Weekly window', usage.sevenDay),
    `Updated ${age} s ago via the Claude Code status line`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className="usage-badge" title={title}>
      {bars.map((bar) => (
        <UsageBar key={bar.label} label={bar.label} percent={bar.percent} />
      ))}
    </span>
  );
}
