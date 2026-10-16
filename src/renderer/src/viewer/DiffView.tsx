import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { loadLanguage } from './languages';
import { viewerTheme } from './theme';

export type DiffMode = 'split' | 'unified';

export interface DiffViewHandle {
  /** Current text of the new/right side. */
  getModified(): string;
  focus(): void;
}

interface Props {
  original: string;
  modified: string;
  /** Used to pick the syntax language. */
  path: string;
  mode: DiffMode;
  /** Whether the right (new) side can be edited. Unified mode is always read-only. */
  editableModified: boolean;
}

const collapse = { margin: 3, minSize: 8 };

export const DiffView = forwardRef<DiffViewHandle, Props>(function DiffView(
  { original, modified, path, mode, editableModified },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const modifiedViewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const langComp = new Compartment();
    const base: Extension[] = [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      history(),
      search({ top: true }),
      syntaxHighlighting(classHighlighter),
      viewerTheme,
      langComp.of([]),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ];
    const frozen: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

    let views: EditorView[];
    let destroy: () => void;
    if (mode === 'split') {
      const mv = new MergeView({
        parent: host,
        a: { doc: original, extensions: [...base, ...frozen] },
        b: {
          doc: modified,
          extensions: [...base, ...(editableModified ? [] : frozen)],
        },
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: collapse,
      });
      views = [mv.a, mv.b];
      modifiedViewRef.current = mv.b;
      destroy = () => mv.destroy();
    } else {
      const view = new EditorView({
        parent: host,
        doc: modified,
        extensions: [
          ...base,
          ...frozen,
          unifiedMergeView({
            original,
            highlightChanges: true,
            gutter: true,
            mergeControls: false,
            collapseUnchanged: collapse,
          }),
        ],
      });
      views = [view];
      modifiedViewRef.current = view;
      destroy = () => view.destroy();
    }

    let cancelled = false;
    void loadLanguage(path).then((support) => {
      if (cancelled || !support) return;
      for (const view of views) view.dispatch({ effects: langComp.reconfigure(support) });
    });

    return () => {
      cancelled = true;
      modifiedViewRef.current = null;
      destroy();
    };
  }, [original, modified, path, mode, editableModified]);

  useImperativeHandle(ref, () => ({
    getModified: () => modifiedViewRef.current?.state.doc.toString() ?? modified,
    focus: () => modifiedViewRef.current?.focus(),
  }));

  return <div ref={hostRef} className="v-diff" />;
});
