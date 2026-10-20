/**
 * Development-only screenshots (ARCODE_SCREENS=<dir>): captures the first project window
 * and the project switcher, then quits. Used to check layout without a human at the screen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { ProjectSwitcher } from './projects';
import type { WindowManager } from './windows';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function captureScreens(outDir: string, windows: WindowManager, switcher: ProjectSwitcher): void {
  mkdirSync(outDir, { recursive: true });
  const shot = async (win: BrowserWindow | undefined, name: string): Promise<void> => {
    if (!win || win.isDestroyed()) return;
    const image = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${name}.png`), image.toPNG());
    console.log(`[screens] ${name}.png ${JSON.stringify(win.getBounds())}`);
  };
  const run = async (): Promise<void> => {
    await delay(4000);
    const projectWindow = BrowserWindow.getAllWindows().find((w) => w !== switcher.paletteWindow());
    if (windows.count() > 0) await shot(projectWindow, 'project');
    switcher.show();
    await delay(1500);
    await shot(switcher.paletteWindow(), 'palette');
    const palette = switcher.paletteWindow();
    if (palette) {
      await palette.webContents.executeJavaScript(
        `(() => { const i = document.querySelector('input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'acd'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await delay(500);
      await shot(palette, 'palette-query');
    }
    if (!process.env.ARCODE_SCREENS_KEEP) app.quit();
  };
  run().catch((error: unknown) => {
    console.error('[screens] failed', error);
    app.quit();
  });
}
