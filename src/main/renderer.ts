import { join } from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { windowQuery } from '@shared/app';
import type { WindowContext } from '@shared/app';

export const PRELOAD_PATH = join(__dirname, '../preload/index.js');

/** Background shown before the first frame, matches --bg in the theme. */
export const WINDOW_BACKGROUND = '#1e1f22';

export function contextFor(view: WindowContext['view'], projectRoot = ''): WindowContext {
  return { view, projectRoot, home: os.homedir() };
}

/** Loads the renderer page; the window context travels in the URL query. */
export function loadRenderer(win: BrowserWindow, context: WindowContext): void {
  const query = windowQuery(context);
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    const url = new URL(devUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query });
  }
}
