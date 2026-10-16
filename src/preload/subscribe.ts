import { ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

/**
 * Listens to a main -> renderer channel without exposing the IPC event object to the page;
 * returns the unsubscribe function every `on*` method of the bridge hands back.
 */
export function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => listener(...(args as Args));
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
