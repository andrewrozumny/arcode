#!/usr/bin/env node
/**
 * Regenerates the README screenshots in docs/screenshots from a demo sandbox (made-up project,
 * made-up Claude session, nothing from your own ~/.claude). Run `pnpm build` first:
 *
 *   pnpm screenshots
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandbox } from './sandbox.mjs';
import { launch, REPO } from './launch.mjs';

const OUT = join(REPO, 'docs', 'screenshots');
const WIDTH = 1440;
const HEIGHT = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const sandbox = buildSandbox(join(tmpdir(), 'acode-demo'));
const app = await launch(sandbox);

const windowOf = async (match) => {
  for (let i = 0; i < 100; i++) {
    const page = app.windows().find((p) => p.url().includes(match));
    if (page) return page;
    await sleep(100);
  }
  throw new Error(`no window with ${match}`);
};

const page = await windowOf('view=project');
await app.evaluate(({ BrowserWindow }, size) => {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.setBackgroundThrottling(false);
    if (w.webContents.getURL().includes('view=project')) w.setBounds({ x: 60, y: 60, ...size });
  }
}, { width: WIDTH, height: HEIGHT });
await page.waitForSelector('.ft-row');

const shot = async (name, target = page) => {
  await sleep(600);
  const file = join(OUT, `${name}.png`);
  await target.screenshot({ path: file });
  console.log(`[screenshots] ${name}.png`);
};
const treeRow = (name) => page.locator('.ft-row', { has: page.locator('.ft-name', { hasText: new RegExp(`^${name}$`) }) }).first();
const activity = (label) => page.locator(`.activity-btn[aria-label^="${label}"]`).first();

// Claude tab in the terminal, the source tree open, the feed showing the session.
await page.getByText('+ Claude').click();
await treeRow('src').locator('.ft-twist').click();
await page.waitForSelector('.ft-name:text-is("passes.ts")');
await page.waitForSelector('.fd-list', { timeout: 20_000 });
await sleep(2500);
await shot('overview');

// A tool group opened into its edits.
await page.locator('.fd-tool.group .fd-row', { hasText: 'Edited' }).first().click();
await sleep(300);
await page.locator('.fd-group-list .fd-row', { hasText: 'passes.ts' }).nth(1).click();
await sleep(300);
await page.locator('.fd-group-list .fd-tool.open').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await shot('feed');

// Code viewer and the diff against HEAD.
await treeRow('passes.ts').dblclick();
await page.waitForSelector('.cm-editor');
await shot('viewer');
await page.locator('[title="Diff with HEAD"]').first().click();
await sleep(800);
await shot('diff');

// Markdown preview.
await treeRow('README.md').dblclick();
await sleep(800);
await shot('markdown');

// Claude panel sections.
await activity('Claude').click();
await sleep(800);
for (const [section, name] of [
  ['Skills', 'panel-skills'],
  ['MCP', 'panel-mcp'],
  ['Hooks', 'panel-hooks'],
  ['Usage', 'panel-usage'],
  ['Sessions', 'panel-sessions'],
  ['Gates', 'panel-gates'],
]) {
  const tab = page.getByRole('tab', { name: section, exact: true }).first();
  if (await tab.count()) {
    await tab.click();
    if (section === 'MCP') {
      await page.getByRole('button', { name: 'Check status' }).click();
      await page.waitForSelector('.cl-badge', { timeout: 15_000 }).catch(() => undefined);
    }
    await shot(name);
  }
}

// Go to file, over the code viewer.
await page.locator('.v-tab', { hasText: 'passes.ts' }).first().click();
await activity('Search').click().catch(() => undefined);
await page.keyboard.type('pass');
await shot('search');
await page.keyboard.press('Escape');

// Project switcher.
await page.locator('[title^="Switch project"]').first().click();
const palette = await windowOf('view=palette');
await sleep(800);
await shot('switcher', palette);

await app.close();

// Retina captures are twice the window size; keep them at 1.5x to stay light in the repo.
for (const file of execFileSync('ls', [OUT]).toString().trim().split('\n')) {
  if (file.endsWith('.png')) execFileSync('sips', ['-Z', String(WIDTH * 1.5), join(OUT, file)], { stdio: 'ignore' });
}
