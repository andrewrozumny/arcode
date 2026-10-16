import { EditorView } from '@codemirror/view';

const MONO = 'var(--font-mono, "JetBrains Mono", ui-monospace, Menlo, monospace)';

/** Editor chrome on theme variables. Token colors live in viewer.css (`.tok-*`). */
export const viewerTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text, #bcbec4)',
      backgroundColor: 'var(--bg, #1e1f22)',
      fontSize: '13px',
      height: '100%',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: MONO, lineHeight: '1.45', overflow: 'auto' },
    '.cm-content': { caretColor: 'var(--text, #bcbec4)', padding: '4px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text, #bcbec4)' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg, #1e1f22)',
      color: '#4e5157',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#a1a3ab' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--selection, #214283)',
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(80, 130, 210, 0.28)' },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(230, 180, 60, 0.28)',
      outline: '1px solid rgba(230, 180, 60, 0.5)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(230, 180, 60, 0.5)' },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(80, 130, 210, 0.3)',
      outline: 'none',
    },
    '.cm-panels': {
      backgroundColor: 'var(--panel-bg, #2b2d30)',
      color: 'var(--text, #bcbec4)',
      borderColor: 'var(--border, #393b40)',
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border, #393b40)' },
    '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: 'var(--font-ui, system-ui, sans-serif)' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      fontFamily: 'var(--font-ui, system-ui, sans-serif)',
      fontSize: '12px',
    },
    '.cm-panel.cm-search input.cm-textfield': {
      backgroundColor: 'var(--bg, #1e1f22)',
      color: 'var(--text, #bcbec4)',
      border: '1px solid var(--border, #393b40)',
      borderRadius: '3px',
      padding: '2px 6px',
    },
    '.cm-panel.cm-search button.cm-button': {
      backgroundImage: 'none',
      backgroundColor: 'transparent',
      color: 'var(--text, #bcbec4)',
      border: '1px solid var(--border, #393b40)',
      borderRadius: '3px',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--text-muted, #6f737a)',
    },
    '.cm-flash-line': { animation: 'v-flash 1.4s ease-out' },
  },
  { dark: true },
);
