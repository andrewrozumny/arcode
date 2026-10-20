import { useEffect, useState } from 'react';
import { viewerApi } from './api';
import { DiffView } from './DiffView';
import type { DiffMode } from './DiffView';

interface Props {
  root: string;
  /** Project-relative path of a file deleted from the working tree. */
  path: string;
}

/** The HEAD version of a deleted file as a read-only diff against nothing (opened from the Changes view). */
export function DeletedFilePane({ root, path }: Props) {
  const [head, setHead] = useState<{ path: string; text: string | null } | null>(null);
  const [mode, setMode] = useState<DiffMode>('unified');

  useEffect(() => {
    let live = true;
    void viewerApi()
      .headContent(root, path)
      .then(
        (text) => live && setHead({ path, text }),
        () => live && setHead({ path, text: null }),
      );
    return () => {
      live = false;
    };
  }, [root, path]);

  const loaded = head?.path === path ? head : null;

  return (
    <div className="v-pane">
      <div className="v-pane-head">
        <span className="v-path" title={path}>
          {path}
        </span>
        <span className="v-muted">Deleted. HEAD version, read-only.</span>
        <span className="v-spacer" />
        <div className="v-seg">
          <button type="button" className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>
            Side by side
          </button>
          <button type="button" className={mode === 'unified' ? 'on' : ''} onClick={() => setMode('unified')}>
            Unified
          </button>
        </div>
      </div>
      <div className="v-body">
        {loaded && loaded.text !== null && (
          <DiffView original={loaded.text} modified="" path={path} mode={mode} editableModified={false} />
        )}
        {loaded?.text === null && (
          <div className="v-placeholder">
            <div className="v-placeholder-title">No HEAD version</div>
            <div className="v-muted v-placeholder-detail">The file is not in the last commit.</div>
          </div>
        )}
      </div>
    </div>
  );
}
