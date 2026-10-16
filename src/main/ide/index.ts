import type { IdeHost } from '@shared/ide';
import { IdeBridge, type IdeBridgeOptions } from './server';

/** Environment variables for pty processes so the CLI picks this bridge. */
export function ideEnv(port: number): Record<string, string> {
  return {
    CLAUDE_CODE_SSE_PORT: String(port),
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
  };
}

export function createIdeBridge(host: IdeHost, options: IdeBridgeOptions = {}) {
  const bridge = new IdeBridge(host, options);
  return {
    start: bridge.start.bind(bridge),
    stop: bridge.stop.bind(bridge),
    get port(): number {
      return bridge.port;
    },
    get authToken(): string {
      return bridge.authToken;
    },
    notifySelectionChanged: bridge.notifySelectionChanged.bind(bridge),
    notifyAtMentioned: bridge.notifyAtMentioned.bind(bridge),
    bridge,
  };
}
