import { useRef } from 'react';
import { DiffView } from './DiffView';
import type { DiffViewHandle } from './DiffView';
import type { DiffRequest } from './types';

interface Props {
  request: DiffRequest;
  onApply: (contents: string) => void;
  onReject: () => void;
}

/** Side-by-side proposal review: old text on the left (read-only), editable new text on the right. */
export function DiffTab({ request, onApply, onReject }: Props) {
  const diffRef = useRef<DiffViewHandle>(null);
  return (
    <div className="v-pane">
      <div className="v-pane-head v-diff-head">
        <span className="v-path" title={request.newPath}>
          {request.newPath}
        </span>
        <span className="v-muted">Review the proposed change. The right side is editable.</span>
        <span className="v-spacer" />
        <button type="button" className="v-btn" onClick={onReject} title="Reject the change">
          Reject
        </button>
        <button
          type="button"
          className="v-btn v-btn-primary"
          title="Accept the right side as the new content"
          onClick={() => onApply(diffRef.current?.getModified() ?? request.newContent)}
        >
          Apply
        </button>
      </div>
      <div className="v-body">
        <DiffView
          ref={diffRef}
          original={request.oldContent}
          modified={request.newContent}
          path={request.newPath || request.oldPath}
          mode="split"
          editableModified
        />
      </div>
    </div>
  );
}
