import { useEffect, useState } from 'react';
import type { GitBranch, GitStatusMap } from '@shared/files';

/** Git status for viewer tab colours; the tree keeps its own copy. */
export function useGitStatus(projectRoot: string): { files: Record<string, string>; branch: GitBranch | null } {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [branch, setBranch] = useState<GitBranch | null>(null);
  useEffect(() => {
    const api = window.acode.files;
    let live = true;
    // The branch is re-read with every status recompute, so a checkout shows up with the status.
    const apply = (map: GitStatusMap): void => {
      if (!live) return;
      setFiles(map.files);
      void api.branch(projectRoot).then(
        (next) => {
          if (live) setBranch((prev) => (prev?.name === next?.name && prev?.detached === next?.detached ? prev : next));
        },
        () => undefined,
      );
    };
    void api.gitStatus(projectRoot).then(apply, () => undefined);
    const off = api.onGitStatus((event) => {
      if (event.root === projectRoot) apply(event.map);
    });
    return () => {
      live = false;
      off();
    };
  }, [projectRoot]);
  return { files, branch };
}
