/**
 * Development-only self test, enabled with ARCODE_SELFTEST=1.
 *
 * Drives the real window through synthetic input events (the same path as a
 * physical keyboard), captures screenshots and prints process metrics. It is
 * used to verify keyboard handling inside interactive TUIs such as Claude Code.
 * Every prompt it types is in shell-escape mode ("!"), so nothing is ever sent
 * to a model even if a keystroke submits the input.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, clipboard } from 'electron';
import type { BrowserWindow, InputEvent } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { PtyManager } from './pty';

type Modifier = NonNullable<InputEvent['modifiers']>[number];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function runSelfTest(win: BrowserWindow, ptys: PtyManager): void {
  const outDir = process.env.ARCODE_SELFTEST_OUT || join(app.getPath('temp'), 'acode-selftest');
  mkdirSync(outDir, { recursive: true });
  const wc = win.webContents;

  const key = (keyCode: string, modifiers: Modifier[] = []): void => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (!modifiers.includes('meta') && !modifiers.includes('control')) {
      wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode, modifiers });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const type = async (text: string): Promise<void> => {
    for (const ch of text) {
      key(ch);
      await delay(15);
    }
  };
  const shot = async (name: string): Promise<void> => {
    const image = await wc.capturePage();
    writeFileSync(join(outDir, `${name}.png`), image.toPNG());
    console.log(`[selftest] screenshot ${name}.png`);
  };
  const metrics = (label: string): void => {
    for (const m of app.getAppMetrics()) {
      console.log(
        `[selftest] metrics ${label} pid=${m.pid} type=${m.type} workingSetKB=${m.memory.workingSetSize} peakKB=${m.memory.peakWorkingSetSize}`,
      );
    }
    console.log(`[selftest] pids main=${process.pid} ptys=${ptys.pids().join(',')}`);
  };

  const run = async (): Promise<void> => {
    await delay(2500);
    // Written straight to the pty: synthetic char events lose letter case.
    const firstPty = ptys.ids()[0];
    const raw = (data: string): void => {
      if (firstPty !== undefined) ptys.write(firstPty, data);
    };
    raw('env | grep -E "^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_CHILD_SESSION)="; ');
    raw('echo "grep-exit=$? ACODE=$ACODE TERM_PROGRAM=$TERM_PROGRAM TERM=$TERM"; claude --version\r');
    await delay(2500);
    await shot('01-env');
    const renderer: unknown = await wc.executeJavaScript(
      `({ webgl: !!document.querySelector('.xterm-screen canvas'), font: getComputedStyle(document.querySelector('.xterm-rows') ?? document.body).fontFamily })`,
    );
    console.log(`[selftest] renderer ${JSON.stringify(renderer)}`);

    await type('claude');
    key('Enter');
    await delay(9000);
    await shot('02-claude-started');
    metrics('claude-running');

    const variants: [string, () => void][] = [
      ['shift-enter-key', () => key('Enter', ['shift'])],
      ['raw-esc-cr', () => raw('\x1b\r')],
      ['raw-csi-u', () => raw('\x1b[13;2u')],
      ['raw-backslash-cr', () => raw('\\\r')],
    ];
    for (const [name, press] of variants) {
      await type('!echo first');
      press();
      await delay(300);
      await type('echo second');
      await delay(1200);
      await shot(`03-${name}`);
      // Clear the input box without submitting.
      key('c', ['control']);
      await delay(600);
    }

    clipboard.writeText('!echo pasted-one\necho pasted-two\necho pasted-three');
    key('v', ['meta']);
    await delay(1500);
    await shot('04-paste');
    key('c', ['control']);
    await delay(600);

    wc.send(IpcChannel.MenuNewTab);
    await delay(2000);
    await shot('05-second-tab');
    metrics('two-tabs');

    key('c', ['control']);
    await delay(300);
    key('c', ['control']);
    await delay(1000);
    if (!process.env.ARCODE_SELFTEST_KEEP) app.quit();
  };

  wc.once('did-finish-load', () => {
    run().catch((error: unknown) => {
      console.error('[selftest] failed', error);
      app.quit();
    });
  });
}
