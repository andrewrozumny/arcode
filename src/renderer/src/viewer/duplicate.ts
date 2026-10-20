import { EditorSelection } from '@codemirror/state';
import type { StateCommand } from '@codemirror/state';

/**
 * JetBrains-style Cmd+D: an empty cursor duplicates its line below, a selection is repeated right
 * after itself (and stays selected on the copy).
 */
export const duplicateLineOrSelection: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tr = state.changeByRange((range) => {
    if (range.empty) {
      const line = state.doc.lineAt(range.head);
      const text = state.sliceDoc(line.from, line.to);
      const offset = range.head - line.from;
      return {
        changes: { from: line.to, insert: `${state.lineBreak}${text}` },
        range: EditorSelection.cursor(line.to + state.lineBreak.length + offset),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.to, insert: text },
      range: EditorSelection.range(range.to, range.to + text.length),
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.duplicate' }));
  return true;
};
