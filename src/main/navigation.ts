/**
 * The app's windows never navigate away from their own page. Without a guard, a file dropped
 * anywhere outside the tree or terminal makes Chromium open it in place of the app, and the
 * navigation ends every terminal of the window (running Claude sessions included).
 */
import type { WebContents } from 'electron';

/** True for a renderer-initiated navigation that would leave the current page (reloads pass). */
export function leavesPage(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin !== target.origin || current.pathname !== target.pathname;
  } catch {
    return true;
  }
}

/**
 * True when a frame inside the page (a PDF tab's iframe, or the PDF viewer inside it) would
 * navigate somewhere it should not: a web page, a mail link or a local file. Links inside a PDF
 * open in the default browser instead.
 */
export function subframeLeaves(targetUrl: string): boolean {
  return /^(https?|mailto|file):/i.test(targetUrl);
}

/** Blocks navigations away from the page; web links go to the default browser instead. */
export function guardNavigation(contents: WebContents, openExternal: (url: string) => void): void {
  contents.on('will-navigate', (event, url) => {
    if (!leavesPage(contents.getURL(), url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) openExternal(url);
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !subframeLeaves(event.url)) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(event.url)) openExternal(event.url);
  });
}
