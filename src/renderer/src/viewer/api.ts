import type { ViewerApi } from '@shared/viewer';

/** `window.acode.viewer`, exposed by the preload script. */
export function viewerApi(): ViewerApi {
  return window.acode.viewer;
}
