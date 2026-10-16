/**
 * Renderer side of the IDE bridge: answers the CLI's diff / open / close requests with the
 * viewer, and keeps the bridge status for the header indicator.
 */
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { IdeStatus } from '@shared/ide-ipc';
import { bus } from '../bus';
import type { ViewerHandle } from '../viewer/types';

const OFFLINE: IdeStatus = { port: 0, clients: 0 };

export function useIdeBridge(viewer: RefObject<ViewerHandle | null>): IdeStatus {
  const [status, setStatus] = useState<IdeStatus>(OFFLINE);

  useEffect(() => {
    const api = window.acode.ide;
    let live = true;
    void api.getStatus().then(
      (initial) => live && setStatus(initial),
      () => undefined,
    );
    const offs = [
      api.onStatus(setStatus),
      api.onOpenDiff((message) => {
        const handle = viewer.current;
        const answer = handle
          ? handle.openDiff({
              tabName: message.tabName,
              oldPath: message.oldPath,
              newPath: message.newPath,
              oldContent: message.oldContent,
              newContent: message.newContent,
            })
          : Promise.resolve({ result: 'closed' as const });
        void answer.then((result) => api.sendOpenDiffResult({ requestId: message.requestId, result }));
      }),
      api.onOpenFile((message) =>
        bus.openFile(message.line ? { path: message.filePath, line: message.line } : { path: message.filePath }),
      ),
      api.onCloseTab((message) => viewer.current?.closeTab(message.tabName)),
      api.onCloseAllDiffTabs(() => viewer.current?.closeAllDiffTabs()),
    ];
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, [viewer]);

  return status;
}
