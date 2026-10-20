/**
 * Starts the built app (out/) inside a demo sandbox through Playwright's Electron driver.
 * Shared by the screenshot and benchmark scripts (scripts/demo, scripts/bench); run `pnpm build` first.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

export const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

export function electronBinary() {
  return join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
}

/** Launches ARcode on `sandbox.root` with the sandbox's home, PATH and user data folder. */
export async function launch(sandbox, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: sandbox.home,
    ZDOTDIR: sandbox.home,
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    SHELL: '/bin/zsh',
    ARCODE_CWD: sandbox.root,
    // No Dock icon and no focus stealing while a script drives the app.
    ARCODE_BACKGROUND: '1',
    ...extraEnv,
  };
  // Parent-session markers would make the app treat itself as running inside Claude Code.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [REPO, `--user-data-dir=${sandbox.userData}`],
    cwd: REPO,
    env,
  });
  return app;
}
