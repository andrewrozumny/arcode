import type { ClaudeApi } from '@shared/claude';

/** `window.acode.claude`, exposed by the preload script. */
export function claudeApi(): ClaudeApi {
  return window.acode.claude;
}
