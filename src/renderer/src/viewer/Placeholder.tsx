import { viewerApi } from './api';
import { formatSize } from '../format';

interface Props {
  root: string;
  path: string;
  title: string;
  /** File size when known. */
  size?: number | undefined;
  detail?: string | undefined;
}

/** Stub for files that cannot be shown: binary, too large, unreadable. */
export function Placeholder({ root, path, title, size, detail }: Props) {
  const api = viewerApi();
  return (
    <div className="v-placeholder">
      <div className="v-placeholder-title">{title}</div>
      {size !== undefined && <div className="v-muted">{formatSize(size)}</div>}
      {detail && <div className="v-muted v-placeholder-detail">{detail}</div>}
      <div className="v-row">
        <button type="button" className="v-btn v-btn-primary" onClick={() => void api.openDefault(root, path)}>
          Open in default app
        </button>
        <button type="button" className="v-btn" onClick={() => void api.reveal(root, path)}>
          Reveal in Finder
        </button>
      </div>
    </div>
  );
}
