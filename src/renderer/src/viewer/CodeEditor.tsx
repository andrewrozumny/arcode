import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { gotoLine, highlightSelectionMatches, search, searchKeymap, selectNextOccurrence } from '@codemirror/search';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { isTypeToEditKey } from './autosave';
import { duplicateLineOrSelection } from './duplicate';
import { loadLanguage } from './languages';
import { viewerTheme } from './theme';
import type { SelectionInfo } from './types';

export interface CodeEditorHandle {
  getValue(): string;
  setValue(text: string): void;
  focus(): void;
  /** Scrolls to a 1-based line/column, centers it and flashes the line. */
  reveal(line: number, column?: number): void;
  openGotoLine(): void;
  getSelection(): SelectionInfo;
}

interface Props {
  path: string;
  /** Initial document; later changes go through `setValue`. */
  initialValue: string;
  readOnly: boolean;
  onChange?: (view: EditorView) => void;
  onSelection?: (info: SelectionInfo) => void;
  /**
   * Typing a printable character while read-only: the editor turns editable at once, inserts the
   * character and calls this so the owner switches to edit mode. Without it, read-only stays read-only.
   */
  onTypeToEdit?: () => void;
}

const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(flashEffect)) continue;
      next =
        effect.value === null
          ? Decoration.none
          : Decoration.set([Decoration.line({ class: 'cm-flash-line' }).range(effect.value)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function selectionOf(view: EditorView): SelectionInfo {
  const { main } = view.state.selection;
  const { doc } = view.state;
  const pos = (offset: number) => {
    const line = doc.lineAt(offset);
    return { line: line.number - 1, character: offset - line.from };
  };
  return {
    start: pos(main.from),
    end: pos(main.to),
    text: main.empty ? null : doc.sliceString(main.from, main.to),
  };
}

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { path, initialValue, readOnly, onChange, onSelection, onTypeToEdit },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyComp = useRef(new Compartment());
  const langComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSelectionRef = useRef(onSelection);
  const onTypeToEditRef = useRef(onTypeToEdit);
  const initialRef = useRef({ value: initialValue, readOnly });

  useEffect(() => {
    onChangeRef.current = onChange;
    onSelectionRef.current = onSelection;
    onTypeToEditRef.current = onTypeToEdit;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialRef.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          foldGutter(),
          history(),
          drawSelection(),
          // Several cursors: Ctrl+G, Cmd+click, Alt+drag for a column selection.
          EditorState.allowMultipleSelections.of(true),
          rectangularSelection(),
          crosshairCursor(),
          closeBrackets(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(classHighlighter),
          viewerTheme,
          flashField,
          readOnlyComp.current.of(EditorState.readOnly.of(initialRef.current.readOnly)),
          langComp.current.of([]),
          keymap.of([
            { key: 'Mod-l', run: gotoLine, preventDefault: true },
            // JetBrains habits: Cmd+D duplicates, Ctrl+G adds the next occurrence (CodeMirror's Cmd+D).
            { key: 'Mod-d', run: duplicateLineOrSelection, preventDefault: true },
            { mac: 'Ctrl-g', key: 'Alt-j', run: selectNextOccurrence, preventDefault: true },
            { key: 'Mod-Shift-ArrowUp', run: moveLineUp, preventDefault: true },
            { key: 'Mod-Shift-ArrowDown', run: moveLineDown, preventDefault: true },
            ...closeBracketsKeymap,
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
          ]),
          EditorView.domEventHandlers({
            keydown: (event, view) => {
              const typeToEdit = onTypeToEditRef.current;
              if (!typeToEdit || !view.state.readOnly || !isTypeToEditKey(event)) return false;
              event.preventDefault();
              view.dispatch({ effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(false)) });
              view.dispatch({ ...view.state.replaceSelection(event.key), scrollIntoView: true, userEvent: 'input.type' });
              typeToEdit();
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.view);
            if (update.selectionSet || update.docChanged) {
              clearTimeout(selectionTimer);
              selectionTimer = setTimeout(() => onSelectionRef.current?.(selectionOf(update.view)), 100);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      clearTimeout(selectionTimer);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    let cancelled = false;
    void loadLanguage(path).then((support) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({ effects: langComp.current.reconfigure(support ?? []) });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useImperativeHandle(ref, () => ({
    getValue: () => viewRef.current?.state.doc.toString() ?? '',
    setValue: (text) => {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() === text) return;
      const anchor = Math.min(view.state.selection.main.anchor, text.length);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor } });
    },
    focus: () => viewRef.current?.focus(),
    reveal: (line, column = 1) => {
      const view = viewRef.current;
      if (!view) return;
      const lineNo = Math.min(Math.max(1, Math.floor(line)), view.state.doc.lines);
      const info = view.state.doc.line(lineNo);
      const pos = Math.min(info.from + Math.max(0, column - 1), info.to);
      view.dispatch({
        selection: { anchor: pos },
        effects: [EditorView.scrollIntoView(pos, { y: 'center' }), flashEffect.of(info.from)],
      });
      view.focus();
      window.setTimeout(() => viewRef.current?.dispatch({ effects: flashEffect.of(null) }), 1500);
    },
    openGotoLine: () => {
      const view = viewRef.current;
      if (view) {
        view.focus();
        gotoLine(view);
      }
    },
    getSelection: () => {
      const view = viewRef.current;
      return view
        ? selectionOf(view)
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text: null };
    },
  }));

  return <div ref={hostRef} className="v-cm" />;
});
