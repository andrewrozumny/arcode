/**
 * Plan usage straight from Claude Code. The status line input carries only the 5-hour and the
 * all-models weekly window; the per-model weekly windows (Fable, and Opus or Sonnet on plans that
 * limit them) come only from the `get_usage` control request of `claude -p` stream-json. That
 * request reads the claude.ai usage endpoint, calls no model and spends no tokens.
 *
 * Every few minutes ARcode starts the user's own `claude` for about a second (hooks off, no MCP,
 * nothing written to the session history), asks once, and writes the answer as one more usage
 * record (`usage/plan.json`, no session, no folder), so the header, the overview and the Usage
 * page pick the plan windows up with the windows the status line reports.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './common';

/** File name of the plan record in the usage folder. */
export const PLAN_RECORD = 'plan.json';
/** Session id of the plan record (it belongs to no session). */
export const PLAN_SESSION = 'plan';
const POLL_MS = 5 * 60 * 1000;
const FIRST_POLL_MS = 5 * 1000;
const ASK_TIMEOUT_MS = 20 * 1000;

export const PLAN_USAGE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--settings',
  '{"disableAllHooks":true}',
  '--strict-mcp-config',
  '--no-session-persistence',
];

interface Win {
  usedPercent: number | null;
  resetsAt: number | null;
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

/** Milliseconds of an ISO time or of epoch seconds. */
function timeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function windowOf(value: unknown): Win | null {
  if (!isRecord(value)) return null;
  const win = { usedPercent: percent(value.utilization), resetsAt: timeMs(value.resets_at) };
  return win.usedPercent === null && win.resetsAt === null ? null : win;
}

/**
 * The usage record for a `get_usage` answer, in the status line script's format; null when the
 * account has no plan limits (API key, Bedrock, Vertex) or the answer has no windows.
 */
export function planRecord(answer: unknown, now: number): Record<string, unknown> | null {
  if (!isRecord(answer) || answer.rate_limits_available === false || !isRecord(answer.rate_limits)) return null;
  const limits = answer.rate_limits;
  const models: (Win & { name: string })[] = [];
  const add = (name: string, win: Win | null): void => {
    if (!win || !name) return;
    const at = models.findIndex((m) => m.name === name);
    if (at >= 0) models.splice(at, 1);
    models.push({ name, ...win });
  };
  add('Opus', windowOf(limits.seven_day_opus));
  add('Sonnet', windowOf(limits.seven_day_sonnet));
  if (Array.isArray(limits.model_scoped)) {
    for (const item of limits.model_scoped.slice(0, 8)) {
      if (isRecord(item) && typeof item.display_name === 'string') add(item.display_name.trim().slice(0, 40), windowOf(item));
    }
  } else if (Array.isArray(limits.limits)) {
    // Older answers: the raw server rows, before Claude Code projected them into model_scoped.
    for (const row of limits.limits.slice(0, 16)) {
      if (!isRecord(row) || row.kind !== 'weekly_scoped' || !isRecord(row.scope) || !isRecord(row.scope.model)) continue;
      const name = row.scope.model.display_name;
      if (typeof name === 'string') add(name.trim().slice(0, 40), windowOf({ utilization: row.percent, resets_at: row.resets_at }));
    }
  }
  const fiveHour = windowOf(limits.five_hour);
  const sevenDay = windowOf(limits.seven_day);
  if (!fiveHour && !sevenDay && models.length === 0) return null;
  return { sessionId: PLAN_SESSION, cwd: null, model: {}, contextWindow: {}, rateLimits: { fiveHour, sevenDay, models }, updatedAt: now };
}

/** Asks a `claude` once for its `get_usage` answer; null on any failure or after the timeout. */
export function askPlanUsage(claude: string, env: Record<string, string>, cwd: string, timeoutMs = ASK_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    const child = spawn(claude, PLAN_USAGE_ARGS, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (value: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      // It exits on its own once stdin closes; make sure it does.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 3000).unref();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      buffer += part;
      if (buffer.length > 4 * 1024 * 1024) return finish(null);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(msg) || msg.type !== 'control_response' || !isRecord(msg.response)) continue;
        const response = msg.response;
        if (response.request_id !== 'usage') continue;
        return finish(response.subtype === 'success' ? response.response : null);
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
  });
}

/** Writes the record atomically; the dot-prefixed temp file is skipped by the usage watcher. */
export function writePlanRecord(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${PLAN_RECORD}`);
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, join(dir, PLAN_RECORD));
}

export class PlanUsagePoller {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly locate: () => Promise<{ claude: string; env: Record<string, string>; cwd: string } | null>,
  ) {}

  start(): void {
    this.timer = setTimeout(() => void this.tick(), FIRST_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const where = await this.locate();
      if (where && !this.stopped) {
        const record = planRecord(await askPlanUsage(where.claude, where.env, where.cwd), Date.now());
        if (record && !this.stopped) writePlanRecord(this.dir, record);
      }
    } catch (error) {
      console.warn('[arcode] plan usage poll failed', error);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), POLL_MS);
  }
}
