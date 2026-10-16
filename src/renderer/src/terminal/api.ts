import type { TerminalApi } from '@shared/terminal';

/** `window.acode.terminal`, exposed by the preload script. */
export function terminalApi(): TerminalApi {
  return window.acode.terminal;
}
