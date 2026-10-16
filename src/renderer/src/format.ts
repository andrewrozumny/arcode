/**
 * Display formatting shared by the renderer's panels. Some helpers look alike but are kept apart on
 * purpose: each matches the precision its panel has always shown.
 */

/** File size with one decimal for KB and MB: `512 B`, `1.5 KB`, `2.0 MB` (viewer). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** File size with whole KB, for dense lists: `512 B`, `2 KB`, `2.0 MB` (import dialog). */
export function formatSizeShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `09 Oct, 14:05` in the user's locale. */
export function formatDayTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Medium date and short time in the user's locale. */
export function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Compact count: 987, 1.2k, 45k, 3.4M, 1.1B. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/** Token count for the header tooltip, whole thousands: 86400 -> `86k`, 1000000 -> `1M`. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

/** Relative age such as "5 min ago" or "3 d ago" for a timestamp string; "" when unknown. */
export function formatAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "3m" / "45s" style age for tooltips. */
export function shortAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

/** Message of an error from `ipcRenderer.invoke`, without Electron's "Error invoking remote method" prefix. */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback;
}
