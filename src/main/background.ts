/**
 * Development-only background mode (ACODE_BACKGROUND=1), used by the screenshot and benchmark
 * scripts: the app stays out of the Dock and shows its windows without taking focus, so a scripted
 * run does not pull the person at the keyboard out of the window they are working in.
 */
import { app } from 'electron';
import type { BrowserWindow } from 'electron';

export const isBackground = process.env.ACODE_BACKGROUND === '1';

export function enterBackgroundMode(): void {
  if (isBackground && process.platform === 'darwin') app.setActivationPolicy('accessory');
}

/** Shows a window, without activating the app in background mode. */
export function reveal(win: BrowserWindow): void {
  if (isBackground) win.showInactive();
  else win.show();
}
