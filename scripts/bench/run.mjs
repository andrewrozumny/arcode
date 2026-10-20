#!/usr/bin/env node
/**
 * App-level benchmarks of the built app (out/) on throwaway sandboxes under $TMPDIR/acode-bench
 * (fake $HOME, made-up projects and Claude sessions, nothing from your own ~/.claude). Prints
 * Markdown tables. Run `pnpm build` first.
 *
 *   node scripts/bench/run.mjs                      # every suite
 *   node scripts/bench/run.mjs --runs 5 --only startup
 *   node scripts/bench/run.mjs --json bench.json    # raw numbers as well
 *
 * Launches are kept to a minimum, because each one opens windows on the desktop:
 *   startup   `--runs` cold launches (default 3), the only thing that needs a restart
 *   session   one launch for everything else: idle memory and CPU, the Claude feed on a small
 *             and a 50 MB transcript, then a second window on a 25k-file project for the file
 *             tree and "go to file"; closed when all of it is measured
 *   size      on-disk sizes, no launch
 */
// Functions passed to page.evaluate run in the renderer, where these browser globals exist.
/* global document, window, MutationObserver, HTMLInputElement */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { benchSandbox, bigProject, growTranscript, keepResumedTranscripts, promptReadyAt, TAIL_MARKER, transcriptPath } from './fixtures.mjs';
import {
  appMetrics,
  assertBuilt,
  fmt,
  fmtSummary,
  footprintMB,
  idleCpu,
  memoryByType,
  REPO,
  sleep,
  start,
  stop,
  summary,
  table,
  timeTo,
} from './lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const RUNS = Number(option('runs', '3'));
const ONLY = option('only', 'startup,session,size').split(',');
const JSON_OUT = option('json', null);
/** How long the app sits untouched before memory is read, and how long idle CPU is sampled. */
const SETTLE_MS = 5000;
const CPU_MS = 10_000;
const FEED_MB = 50;
/** Session id of the large transcript, next to the sandbox's demo session. */
const LARGE_SESSION = '0b9c6a1e-4d2f-4b8a-9e3c-5f7a1d2c3b40';
const TREE_FILES = 20_000;
const TREE_FLAT = 5000;
const TREE_FLAT_DIRS = 3;
/** Reads repeated over IPC; the median is reported. */
const IPC_REPEATS = 10;

const log = (message) => console.error(`[bench] ${message}`);
const results = {};
const sections = [];
const size = (bytes) => (bytes < 1024 * 1024 ? `${fmt(bytes / 1024)} KB` : `${fmt(bytes / 1024 / 1024, 1)} MB`);

/** Waits until the first shell prompt has been stamped; returns its time from `t0`. */
async function promptTime(sandbox, t0, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const at = promptReadyAt(sandbox);
    if (at !== null) return at - t0;
    await sleep(10);
  }
  return null;
}

async function suiteStartup() {
  const sandbox = benchSandbox('startup');
  const samples = [];
  for (let i = 1; i <= RUNS; i++) {
    rmSync(join(sandbox.home, '.prompt-ready'), { force: true });
    const run = await start(sandbox);
    const { page, t0 } = run;
    const [shown, tree, xterm, prompt] = await Promise.all([
      page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 30_000, polling: 'raf' }).then(() => Date.now() - t0),
      timeTo(page, t0, '.ft-row'),
      timeTo(page, t0, '.xterm'),
      promptTime(sandbox, t0),
    ]);
    await sleep(300);
    const sample = { shown, tree, xterm, prompt, firstFrameLog: run.firstFrameLog() };
    await stop(run.app, sandbox);
    samples.push(sample);
    log(`startup run ${i}: ${JSON.stringify(sample)}`);
  }
  const s = (key) => summary(samples.map((x) => x[key]).filter((v) => typeof v === 'number'));
  const r = { samples, shown: s('shown'), tree: s('tree'), xterm: s('xterm'), prompt: s('prompt'), firstFrameLog: s('firstFrameLog') };
  results.startup = r;
  const row = (label, x) => [label, `${fmt(x.median)} ms`, `${fmt(x.min)} ms`, `${fmt(x.max)} ms`];
  sections.push(
    `### Startup (${RUNS} launches, wall clock from process spawn)\n\n` +
      table(
        ['Milestone', 'Median', 'Min', 'Max'],
        [
          row('Project window visible', r.shown),
          row('File tree: first row', r.tree),
          row('Terminal mounted (xterm)', r.xterm),
          row('Shell prompt drawn (zsh precmd)', r.prompt),
          row('First terminal frame (app log, from main start)', r.firstFrameLog),
        ],
      ),
  );
}

/** Working set and physical footprint now, then average CPU over CPU_MS. */
async function idleSnapshot(app) {
  await sleep(SETTLE_MS);
  const metrics = await appMetrics(app);
  const memory = memoryByType(metrics);
  const footprint = footprintMB(metrics.map((m) => m.pid));
  const cpu = await idleCpu(app, CPU_MS);
  return { memory, footprint, cpu, processes: metrics.length };
}

/** Times one feed read from the renderer through IPC, `count` times. */
async function feedIpc(page, request, count = IPC_REPEATS) {
  const out = await page.evaluate(
    async ({ request, count }) => {
      const times = [];
      let chunk = null;
      for (let i = 0; i < count; i++) {
        const t = performance.now();
        chunk = await window.acode.claude.feed(request);
        times.push(performance.now() - t);
      }
      return { times, items: chunk.items.length, bytes: chunk.end - chunk.start };
    },
    { request, count },
  );
  return { ...out, ms: summary(out.times) };
}

/**
 * Resumes a session from the Claude panel's Sessions list, then shows the feed tab and returns the
 * ms from that click until `marker` is in the feed. The Sessions list is a viewer tab too, and the
 * feed reads nothing while hidden, so the timed part is the feed loading and rendering the session.
 */
async function resumeSession(page, firstPrompt, marker) {
  const row = page.locator('.cl-row', { hasText: firstPrompt }).first();
  if (!(await row.isVisible().catch(() => false))) {
    await page.locator('.activity-btn[aria-label^="Claude"]').first().click();
    await page.getByRole('tab', { name: 'Sessions', exact: true }).first().click();
  }
  await row.waitFor({ timeout: 30_000 });
  await row.locator('button', { hasText: 'Resume' }).click();
  // Let the new terminal tab start and hand its session to the feed.
  await sleep(1000);
  const feedTab = page.locator('.v-tab', { hasText: /^Claude$/ }).first();
  const t = Date.now();
  await feedTab.click();
  await page.waitForFunction((m) => document.querySelector('.fd-list')?.textContent?.includes(m), marker, { timeout: 60_000, polling: 'raf' });
  return Date.now() - t;
}

/** Clicks "Load earlier" and returns the ms until the list has grown, measured in the page. */
async function loadEarlier(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const list = document.querySelector('.fd-list');
        const button = document.querySelector('.fd-earlier');
        if (!list || !button) return resolve(null);
        const before = list.children.length;
        const t = performance.now();
        const observer = new MutationObserver(() => {
          if (list.children.length > before + 1) {
            observer.disconnect();
            resolve(performance.now() - t);
          }
        });
        observer.observe(list, { childList: true });
        button.click();
        setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, 10_000);
      }),
  );
}

/**
 * Sets the "go to file" input to `query` and resolves with the ms until the first result starts
 * with `expect`, measured in the page with a MutationObserver (results in the DOM, before paint).
 */
async function goToFile(page, query, expect) {
  return page.evaluate(
    ({ query, expect }) =>
      new Promise((resolve) => {
        const input = document.querySelector('.fs-input');
        const list = document.querySelector('.fs-list');
        if (!input || !list) return resolve(null);
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const done = () => document.querySelector('.fs-item')?.textContent?.startsWith(expect);
        const t = performance.now();
        const observer = new MutationObserver(() => {
          if (done()) {
            observer.disconnect();
            resolve(performance.now() - t);
          }
        });
        observer.observe(list, { childList: true, subtree: true, characterData: true });
        setValue.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, 10_000);
      }),
    { query, expect },
  );
}

/** Feed on the demo and the large transcript, each resumed RUNS times, alternating. */
async function measureFeed(page, sandbox) {
  const cases = {
    small: { prompt: 'Let callers of /passes', marker: 'The fixed-window limiter is in', sessionId: sandbox.sessionId, render: [] },
    large: { prompt: 'Step 0: tighten', marker: TAIL_MARKER, sessionId: LARGE_SESSION, render: [] },
  };
  for (let i = 0; i < RUNS; i++) {
    for (const [key, c] of Object.entries(cases)) {
      const ms = await resumeSession(page, c.prompt, c.marker);
      c.render.push(ms);
      log(`feed ${key} resume ${i + 1}: ${ms} ms`);
    }
  }
  const out = {};
  for (const [key, c] of Object.entries(cases)) {
    const bytes = statSync(transcriptPath(sandbox, c.sessionId)).size;
    const tail = await feedIpc(page, { sessionId: c.sessionId });
    const poll = await feedIpc(page, { sessionId: c.sessionId, from: bytes });
    const earlier = await feedIpc(page, { sessionId: c.sessionId, before: Math.floor(bytes / 2) });
    out[key] = { bytes, render: summary(c.render), renderSamples: c.render, tail: tail.ms, tailItems: tail.items, tailBytes: tail.bytes, poll: poll.ms, earlier: earlier.ms };
  }
  // The large session is on screen (resumed last): its blocks, then "Load earlier" through the button.
  out.large.blocks = await page.evaluate(() => document.querySelector('.fd-list')?.children.length ?? 0);
  out.large.loadEarlier = await loadEarlier(page);
  return out;
}

/** Second window on a large project: tree, folder expand, file index and "go to file". */
async function measureTree(app, page, root) {
  const known = new Set(app.windows());
  const t0 = Date.now();
  await page.evaluate((r) => window.acode.projects.open(r), root);
  let win = null;
  while (!win && Date.now() - t0 < 30_000) {
    win = app.windows().find((p) => !known.has(p) && p.url().includes('view=project')) ?? null;
    if (!win) await sleep(10);
  }
  if (!win) throw new Error('large project window did not open');
  const tree = await timeTo(win, t0, '.ft-row');

  // Expanding folders with TREE_FLAT entries each, never opened before: click to first child row.
  const expand = [];
  for (let d = 1; d <= TREE_FLAT_DIRS; d++) {
    const row = win.locator('.ft-row', { has: win.locator('.ft-name', { hasText: new RegExp(`^flat${d}$`) }) }).first();
    await row.waitFor();
    const twist = row.locator('.ft-twist');
    const toggle = async () => ((await twist.count()) ? twist : row).click();
    const child = win.locator('.ft-row', { has: win.locator('.ft-name', { hasText: /^entry-00000\.ts$/ }) }).first();
    const t = Date.now();
    await toggle();
    await child.waitFor();
    expand.push(Date.now() - t);
    // Collapse again: the virtualised tree only renders rows in view, and the next folder sits below.
    await toggle();
    await child.waitFor({ state: 'detached' });
  }

  const queries = [
    ['feature12345', 'feature12345.ts'],
    ['feature777', 'feature777.ts'],
    ['entry04321', 'entry-04321.ts'],
    ['m03s07', 'feature'],
  ];
  const ipc = await win.evaluate(
    async ({ root, queries, repeats }) => {
      const timed = async (q) => {
        const t = performance.now();
        const found = await window.acode.files.search(root, q, 50);
        return { ms: performance.now() - t, top: found[0]?.path ?? null };
      };
      const first = await timed(queries[0][0]);
      const warm = [];
      for (let r = 0; r < 5; r++) for (const [q] of queries) warm.push((await timed(q)).ms);
      // Listing one big folder over IPC splits the expand time into main-side work and rendering.
      const list = [];
      for (let r = 0; r < repeats; r++) {
        const t = performance.now();
        await window.acode.files.listDir(root, 'flat1');
        list.push(performance.now() - t);
      }
      return { first, warm, list };
    },
    { root, queries, repeats: 5 },
  );

  await win.locator('.activity-btn[aria-label^="Search"]').first().click();
  await win.waitForSelector('.fs-input');
  await sleep(200);
  const ui = [];
  for (let r = 0; r < 3; r++) {
    for (const [q, expect] of queries) {
      const ms = await goToFile(win, q, expect);
      if (ms !== null) ui.push(ms);
      // Something different in between, so the next query changes the list.
      await goToFile(win, 'readme', 'README.md');
    }
  }
  await win.keyboard.press('Escape');

  const lsFiles = [];
  for (let i = 0; i < IPC_REPEATS; i++) {
    const t = performance.now();
    execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    lsFiles.push(performance.now() - t);
  }
  return {
    files: TREE_FILES + TREE_FLAT * TREE_FLAT_DIRS + 1,
    tree,
    expand: summary(expand),
    expandSamples: expand,
    listDir: summary(ipc.list),
    firstSearch: ipc.first,
    search: summary(ipc.warm),
    ui: summary(ui),
    lsFiles: summary(lsFiles),
  };
}

async function suiteSession() {
  const sandbox = benchSandbox('session');
  keepResumedTranscripts(sandbox);
  const bytes = growTranscript(sandbox, FEED_MB * 1024 * 1024, LARGE_SESSION);
  log(`session: large transcript ${size(bytes)}`);
  const root = bigProject(sandbox, { files: TREE_FILES, flat: TREE_FLAT, flatDirs: TREE_FLAT_DIRS });
  log('session: large project written');

  const run = await start(sandbox);
  const { app, page } = run;
  try {
    await page.waitForSelector('.ft-row');
    const focused = await page.evaluate(() => document.hasFocus());
    const idleProject = await idleSnapshot(app);
    log(`idle, project: ${JSON.stringify(idleProject)}`);
    const feed = await measureFeed(page, sandbox);
    log(`feed: ${JSON.stringify(feed)}`);
    const idleFeed = await idleSnapshot(app);
    log(`idle, feed: ${JSON.stringify(idleFeed)}`);
    const tree = await measureTree(app, page, root);
    log(`tree: ${JSON.stringify(tree)}`);
    const twoWindows = await idleSnapshot(app);
    log(`idle, two windows: ${JSON.stringify(twoWindows)}`);
    results.session = { focused, idleProject, feed, idleFeed, tree, twoWindows };
  } finally {
    await stop(app, sandbox);
  }

  const { focused, idleProject, idleFeed, twoWindows, feed, tree } = results.session;
  const byType = (m) => Object.entries(m.byType).sort().map(([t, v]) => `${t} ${fmt(v)}`).join(', ');
  const memRow = (label, x) => [label, `${fmt(x.memory.total)} MB`, x.footprint === null ? 'n/a' : `${fmt(x.footprint)} MB`, byType(x.memory), `${fmt(x.cpu.total, 2)} %`];
  sections.push(
    `### Memory and idle CPU (one launch; memory read ${SETTLE_MS / 1000} s after each step, CPU averaged over the next ${CPU_MS / 1000} s; window focused: ${focused ? 'yes' : 'no'})\n\n` +
      table(
        ['State', 'Working set, all app processes', 'Physical footprint, all app processes', 'Working set by process type, MB', 'Idle CPU, % of one core'],
        [
          memRow('One project window, shell tab', idleProject),
          memRow(`Plus ${RUNS * 2} resumed Claude tabs, feed showing the ${size(feed.large.bytes)} session`, idleFeed),
          memRow(`Plus a second window on the ${tree.files.toLocaleString('en-US')}-file project`, twoWindows),
        ],
      ),
  );
  const both = (label, pick, digits = 0) => [label, pick(feed.small, digits), pick(feed.large, digits)];
  const s = (key, unit = 'ms') => (c, digits) => fmtSummary(c[key], unit, digits);
  sections.push(
    `### Claude feed (same launch; median (min-max))\n\n` +
      table(
        ['Measurement', `Demo transcript (${size(feed.small.bytes)})`, `Large transcript (${size(feed.large.bytes)})`],
        [
          both(`Resumed session: click the feed tab to last message on screen (${RUNS} times each)`, s('render')),
          both(`First load over IPC: tail read, parse, transfer (${IPC_REPEATS} reads)`, s('tail'), 1),
          both(`Live poll over IPC, nothing new (${IPC_REPEATS} reads)`, s('poll'), 2),
          both(`"Load earlier" over IPC from the middle (${IPC_REPEATS} reads)`, s('earlier'), 1),
          ['"Load earlier" button: click to new rows in the DOM', 'n/a (whole file already loaded)', feed.large.loadEarlier === null ? 'n/a' : `${fmt(feed.large.loadEarlier)} ms`],
          ['Bytes read by the first load / feed items', `${size(feed.small.tailBytes)} / ${feed.small.tailItems}`, `${size(feed.large.tailBytes)} / ${feed.large.tailItems}`],
        ],
      ),
  );
  sections.push(
    `### Large project (${tree.files.toLocaleString('en-US')} files in git, second window of the same launch; median (min-max))\n\n` +
      table(
        ['Measurement', 'Result'],
        [
          ['Open project to first file tree row', `${fmt(tree.tree)} ms`],
          [`Expand a folder with ${TREE_FLAT.toLocaleString('en-US')} files: click to first child row (${TREE_FLAT_DIRS} folders)`, fmtSummary(tree.expand, 'ms')],
          ['List such a folder over IPC (readdir and one `git check-ignore`)', fmtSummary(tree.listDir, 'ms')],
          ['`git ls-files -co --exclude-standard -z` (what the file index runs), outside the app', fmtSummary(tree.lsFiles, 'ms', 1)],
          ['Go to file over IPC, first query (index is warmed when the window opens)', `${fmt(tree.firstSearch.ms, 1)} ms`],
          ['Go to file over IPC, later queries: rank and return top 50', fmtSummary(tree.search, 'ms', 1)],
          ['Go to file in the UI: input change to results in the DOM', fmtSummary(tree.ui, 'ms', 1)],
        ],
      ),
  );
}

/** On-disk size in MB, from `du -sk` (allocated blocks, so it matches Finder's "on disk"). */
function duMB(path) {
  if (!existsSync(path)) return null;
  return Number(execFileSync('du', ['-sk', path]).toString().split('\t')[0]) / 1024;
}

function suiteSize() {
  const entries = [
    ['ARcode out/ (bundled JS, CSS, assets)', join(REPO, 'out')],
    ['ARcode.app (dist/mac-arm64, unsigned)', join(REPO, 'dist/mac-arm64/ARcode.app')],
    ['ARcode.app app.asar only', join(REPO, 'dist/mac-arm64/ARcode.app/Contents/Resources/app.asar')],
    ['Electron Framework inside ARcode.app', join(REPO, 'dist/mac-arm64/ARcode.app/Contents/Frameworks/Electron Framework.framework')],
    ['/Applications/Cursor.app', '/Applications/Cursor.app'],
    ['/Applications/Visual Studio Code.app', '/Applications/Visual Studio Code.app'],
    ['/Applications/PhpStorm.app', '/Applications/PhpStorm.app'],
  ];
  results.size = Object.fromEntries(entries.map(([label, path]) => [label, duMB(path)]));
  sections.push(
    '### On-disk size (`du -sk`)\n\n' +
      table(
        ['Bundle', 'Size'],
        entries.map(([label]) => [label, results.size[label] === null ? 'not present' : `${fmt(results.size[label])} MB`]),
      ),
  );
}

assertBuilt();
const machine = (() => {
  const sys = (key) => execFileSync('sysctl', ['-n', key]).toString().trim();
  const sw = (flag) => execFileSync('sw_vers', [flag]).toString().trim();
  return {
    cpu: sys('machdep.cpu.brand_string'),
    cores: cpus().length,
    memoryGB: Math.round(totalmem() / 1024 ** 3),
    macos: `${sw('-productVersion')} (${sw('-buildVersion')})`,
    electron: JSON.parse(readFileSync(join(REPO, 'node_modules/electron/package.json'), 'utf8')).version,
    node: process.version,
  };
})();
results.machine = machine;
log(`machine: ${JSON.stringify(machine)}`);

const suites = { startup: suiteStartup, session: suiteSession, size: suiteSize };
for (const name of ONLY) {
  if (!suites[name]) throw new Error(`unknown suite ${name}`);
  log(`suite ${name}`);
  await suites[name]();
}

console.log(`## ARcode benchmarks\n\n${machine.cpu}, ${machine.cores} cores, ${machine.memoryGB} GB, macOS ${machine.macos}, Electron ${machine.electron}\n`);
console.log(sections.join('\n\n'));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
