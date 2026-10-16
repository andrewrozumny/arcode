/**
 * Helpers shared by the app-level benchmarks: launching the built app on a sandbox, waiting for
 * windows, reading process metrics, and summarising repeated measurements.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, REPO } from '../demo/launch.mjs';

export { REPO };

/**
 * Root folder for every sandbox the benchmarks build. Kept apart from the screenshot script's
 * `acode-demo`, which may run at the same time.
 */
export const BENCH_DIR = join(tmpdir(), 'acode-bench');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median, min and max of a list of numbers, plus how many there were. */
export function summary(values) {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values), n: values.length };
}

export function assertBuilt() {
  if (!existsSync(join(REPO, 'out/main/index.js'))) {
    throw new Error('out/ is missing: run `pnpm build` first');
  }
}

/**
 * Launches the app and records when the project window shows up. `t0` is taken right before the
 * Electron process is spawned, so every time reported is wall clock from spawn.
 */
export async function start(sandbox, extraEnv = {}) {
  const t0 = Date.now();
  const app = await launch(sandbox, extraEnv);
  // The main process logs its own first-frame time; keep it as an in-app cross-check.
  let firstFrameLog = null;
  app.process().stdout?.on('data', (chunk) => {
    const match = /first terminal frame .*?(\d+) ms after process start/.exec(chunk.toString());
    if (match && firstFrameLog === null) firstFrameLog = Number(match[1]);
  });
  const page = await projectPage(app);
  return { app, page, t0, firstFrameLog: () => firstFrameLog };
}

export async function projectPage(app) {
  for (let i = 0; i < 300; i++) {
    const page = app.windows().find((p) => p.url().includes('view=project'));
    if (page) return page;
    await sleep(20);
  }
  throw new Error('no project window');
}

/**
 * Closes the app and ends anything it left behind. Ptys normally die with their window; the
 * pkill is a safety net for the sandbox's stand-in `claude`.
 */
export async function stop(app, sandbox) {
  await app.close().catch(() => undefined);
  try {
    execFileSync('pkill', ['-f', join(sandbox.bin, 'claude')], { stdio: 'ignore' });
  } catch {
    // Nothing left running.
  }
}

/** Every Electron process of the app with its type, pid, working set and CPU time so far. */
export async function appMetrics(app) {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      workingSetKB: m.memory.workingSetSize,
      peakKB: m.memory.peakWorkingSetSize,
      cpuSeconds: m.cpu.cumulativeCPUUsage ?? null,
    })),
  );
}

/**
 * Physical footprint (what Activity Monitor's Memory column shows) of the given pids, in MB,
 * read with macOS `footprint`. Null when the tool fails.
 */
export function footprintMB(pids) {
  const dir = mkdtempSync(join(tmpdir(), 'acode-bench-fp-'));
  const file = join(dir, 'fp.json');
  try {
    execFileSync('footprint', ['-f', 'bytes', '--noCategories', '-j', file, ...pids.flatMap((pid) => ['-p', String(pid)])], { stdio: 'ignore' });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const total = (data.processes ?? []).reduce((sum, p) => sum + (p.footprint ?? 0), 0);
    return total / 1024 / 1024;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Working set per process type and in total, in MB. */
export function memoryByType(metrics) {
  const byType = {};
  for (const m of metrics) byType[m.type] = (byType[m.type] ?? 0) + m.workingSetKB / 1024;
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  return { total, byType };
}

/**
 * Average CPU of all app processes over `ms`, as percent of one core, from the difference of
 * cumulative CPU time. Processes that appear or end in between are left out.
 */
export async function idleCpu(app, ms) {
  const before = await appMetrics(app);
  const t = Date.now();
  await sleep(ms);
  const after = await appMetrics(app);
  const elapsed = (Date.now() - t) / 1000;
  const first = new Map(before.map((m) => [m.pid, m]));
  const byType = {};
  let total = 0;
  for (const m of after) {
    const prev = first.get(m.pid);
    if (!prev || prev.cpuSeconds === null || m.cpuSeconds === null) continue;
    const pct = ((m.cpuSeconds - prev.cpuSeconds) / elapsed) * 100;
    byType[m.type] = (byType[m.type] ?? 0) + pct;
    total += pct;
  }
  return { total, byType, seconds: elapsed };
}

/** Milliseconds from `t0` until `selector` is in the page. */
export async function timeTo(page, t0, selector, timeout = 30_000) {
  await page.waitForSelector(selector, { timeout });
  return Date.now() - t0;
}

export const fmt = (n, digits = 0) => (n === null || n === undefined || Number.isNaN(n) ? 'n/a' : n.toFixed(digits));

/** "median (min-max)" of a summary, with a unit. */
export const fmtSummary = (s, unit, digits = 0) => `${fmt(s.median, digits)} ${unit} (${fmt(s.min, digits)}-${fmt(s.max, digits)})`;

export function table(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
