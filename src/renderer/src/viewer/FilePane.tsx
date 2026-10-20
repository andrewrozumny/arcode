import type { EditorView } from '@codemirror/view';
import type { ReadFileResult } from '@shared/viewer';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { viewerApi } from './api';
import { CodeEditor } from './CodeEditor';
import type { CodeEditorHandle } from './CodeEditor';
import { DiffView } from './DiffView';
import type { DiffMode } from './DiffView';
import { DiffIcon, PencilIcon, SaveIcon } from './Icons';
import { languageNameForPath } from './languages';
import { MarkdownPreview } from './MarkdownPreview';
import { extension } from './paths';
import { Placeholder } from './Placeholder';
import { ImageView } from './ImageView';
import { PdfView } from './PdfView';
import type { SelectionInfo } from './types';

export interface FilePaneHandle {
  save(): Promise<void>;
  toggleEdit(): void;
  reveal(line: number, column?: number): void;
  focus(): void;
  isDirty(): boolean;
}

export interface RevealRequest {
  line: number;
  column: number;
  nonce: number;
}

interface Props {
  root: string;
  path: string;
  active: boolean;
  reveal: RevealRequest | null;
  onDirtyChange: (path: string, dirty: boolean) => void;
  /** Selection of the pane; null for panes without a text cursor. Only called while active. */
  onSelection: (path: string, info: SelectionInfo | null) => void;
  onOpenFile: (path: string, line?: number) => void;
}

type Banner =
  | { type: 'external' }
  | { type: 'deleted' }
  | { type: 'conflict' }
  | { type: 'error'; message: string };

interface DiffState {
  mode: DiffMode;
  original: string;
  modified: string;
  isNew: boolean;
}

const isMarkdown = (path: string): boolean => ['md', 'markdown', 'mdx'].includes(extension(path));

export const FilePane = forwardRef<FilePaneHandle, Props>(function FilePane(
  { root, path, active, reveal, onDirtyChange, onSelection, onOpenFile },
  ref,
) {
  const api = viewerApi();
  const md = isMarkdown(path);
  const [data, setData] = useState<ReadFileResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [mdMode, setMdMode] = useState<'preview' | 'source'>('preview');
  const [svgMode, setSvgMode] = useState<'image' | 'source'>('image');
  const [previewText, setPreviewText] = useState('');
  const [editorShown, setEditorShown] = useState(!md);
  const [dirty, setDirty] = useState(false);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const mtimeRef = useRef<number | null>(null);
  const savedRef = useRef('');
  const dirtyRef = useRef(false);
  const appliedReveal = useRef(0);

  const markDirty = useCallback(
    (value: boolean) => {
      if (dirtyRef.current === value) return;
      dirtyRef.current = value;
      setDirty(value);
      onDirtyChange(path, value);
    },
    [onDirtyChange, path],
  );

  const load = useCallback(async () => {
    const result = await api.readFile(root, path);
    if (result.kind === 'text') {
      mtimeRef.current = result.mtime;
      savedRef.current = result.content;
      setPreviewText(result.content);
      editorRef.current?.setValue(result.content);
    } else if (result.kind === 'image' || result.kind === 'pdf') {
      mtimeRef.current = result.mtime;
    }
    setData(result);
    setBanner(null);
    markDirty(false);
  }, [api, root, path, markDirty]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.watchFile(root, path);
    const off = api.onFileChanged((event) => {
      if (event.root !== root || event.relPath !== path) return;
      if (event.mtime === null) setBanner({ type: 'deleted' });
      else if (event.mtime === mtimeRef.current) return;
      else if (dirtyRef.current) setBanner({ type: 'external' });
      else void load();
    });
    return () => {
      off();
      void api.unwatchFile(root, path);
    };
  }, [api, root, path, load]);

  const onDocChange = useCallback(
    (view: EditorView) => {
      const doc = view.state.doc;
      markDirty(doc.length !== savedRef.current.length || doc.toString() !== savedRef.current);
    },
    [markDirty],
  );

  const save = useCallback(
    async (expectedOverride?: number | null) => {
      const editor = editorRef.current;
      if (!editor) return;
      if (!dirtyRef.current && expectedOverride === undefined) return;
      const text = editor.getValue();
      const expected = expectedOverride === undefined ? mtimeRef.current : expectedOverride;
      const result = await api.writeFile(root, path, text, expected);
      if (result.ok) {
        mtimeRef.current = result.mtime;
        savedRef.current = text;
        setPreviewText(text);
        setBanner(null);
        markDirty(editor.getValue() !== text);
      } else if (result.reason === 'conflict') {
        setBanner({ type: 'conflict' });
      } else {
        setBanner({ type: 'error', message: result.message });
      }
    },
    [api, root, path, markDirty],
  );

  const overwrite = useCallback(async () => {
    const latest = await api.readFile(root, path);
    const mtime = latest.kind === 'text' || latest.kind === 'image' || latest.kind === 'pdf' ? latest.mtime : null;
    await save(mtime);
  }, [api, root, path, save]);

  const showSource = useCallback(() => {
    setEditorShown(true);
    setMdMode('source');
  }, []);

  const toggleEdit = useCallback(() => {
    if (data?.kind !== 'text') return;
    if (md && mdMode === 'preview') showSource();
    setEditing((value) => !value);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  }, [data, md, mdMode, showSource]);

  const setPreviewMode = useCallback(() => {
    setPreviewText(editorRef.current?.getValue() ?? savedRef.current);
    setMdMode('preview');
  }, []);

  const revealLine = useCallback(
    (line: number, column?: number) => {
      if (md) showSource();
      setDiff(null);
      window.requestAnimationFrame(() => editorRef.current?.reveal(line, column));
    },
    [md, showSource],
  );

  useImperativeHandle(ref, () => ({
    save: () => save(),
    toggleEdit,
    reveal: revealLine,
    focus: () => editorRef.current?.focus(),
    isDirty: () => dirtyRef.current,
  }));

  // Apply a reveal request once the editor exists.
  useEffect(() => {
    if (!reveal || data?.kind !== 'text' || reveal.nonce === appliedReveal.current) return;
    appliedReveal.current = reveal.nonce;
    revealLine(reveal.line, reveal.column);
  }, [reveal, data, revealLine]);

  // Report the selection when this pane becomes the active one.
  useEffect(() => {
    if (!active) return;
    onSelection(path, data?.kind === 'text' && editorShown ? (editorRef.current?.getSelection() ?? null) : null);
  }, [active, data, editorShown, onSelection, path]);

  const openHeadDiff = async (mode: DiffMode): Promise<void> => {
    const head = await api.headContent(root, path);
    setDiff({
      mode,
      original: head ?? '',
      modified: editorRef.current?.getValue() ?? savedRef.current,
      isNew: head === null,
    });
  };

  if (!data) return <div className="v-pane v-loading" />;

  const text = data.kind === 'text';
  const svg = data.kind === 'image' && data.svgSource !== undefined;
  const showPreview = text && md && mdMode === 'preview' && !diff;
  const editorHidden = !text || showPreview || diff !== null;

  return (
    <div className="v-pane">
      <div className="v-pane-head">
        <span className="v-path" title={path}>
          {path}
        </span>
        {text && <span className="v-muted v-lang">{languageNameForPath(path) ?? 'Plain text'}</span>}
        <span className="v-spacer" />
        {text && md && (
          <div className="v-seg">
            <button
              type="button"
              className={mdMode === 'preview' ? 'on' : ''}
              onClick={setPreviewMode}
            >
              Preview
            </button>
            <button type="button" className={mdMode === 'source' ? 'on' : ''} onClick={showSource}>
              Source
            </button>
          </div>
        )}
        {svg && (
          <div className="v-seg">
            <button type="button" className={svgMode === 'image' ? 'on' : ''} onClick={() => setSvgMode('image')}>
              Image
            </button>
            <button type="button" className={svgMode === 'source' ? 'on' : ''} onClick={() => setSvgMode('source')}>
              Source
            </button>
          </div>
        )}
        {data.kind === 'pdf' && data.markdownSource && (
          <button
            type="button"
            className="v-btn"
            title={`Open ${data.markdownSource}`}
            onClick={() => data.markdownSource && onOpenFile(data.markdownSource)}
          >
            Open Markdown source
          </button>
        )}
        {data.kind === 'pdf' && (
          <button type="button" className="v-btn" title="Open in the default PDF app" onClick={() => void api.openDefault(root, path)}>
            Open in default app
          </button>
        )}
        {text && diff && (
          <div className="v-seg">
            <button
              type="button"
              className={diff.mode === 'split' ? 'on' : ''}
              onClick={() => setDiff({ ...diff, mode: 'split' })}
            >
              Side by side
            </button>
            <button
              type="button"
              className={diff.mode === 'unified' ? 'on' : ''}
              onClick={() => setDiff({ ...diff, mode: 'unified' })}
            >
              Unified
            </button>
          </div>
        )}
        {text && (
          <button
            type="button"
            className={diff ? 'v-btn on' : 'v-btn'}
            title="Diff with HEAD"
            onClick={() => (diff ? setDiff(null) : void openHeadDiff('split'))}
          >
            <DiffIcon /> Diff with HEAD
          </button>
        )}
        {text && (
          <button
            type="button"
            className={editing ? 'v-btn on' : 'v-btn'}
            title="Toggle edit mode (Cmd+E)"
            onClick={toggleEdit}
          >
            <PencilIcon /> {editing ? 'Editing' : 'Edit'}
          </button>
        )}
        {text && dirty && (
          <button type="button" className="v-btn v-btn-primary" title="Save (Cmd+S)" onClick={() => void save()}>
            <SaveIcon /> Save
          </button>
        )}
      </div>

      {banner && (
        <div className="v-banner">
          {banner.type === 'conflict' && (
            <>
              <span>This file was changed on disk since you opened it.</span>
              <button type="button" className="v-btn" onClick={() => void overwrite()}>
                Overwrite
              </button>
              <button type="button" className="v-btn" onClick={() => void load()}>
                Reload from disk
              </button>
            </>
          )}
          {banner.type === 'external' && (
            <>
              <span>Changed on disk. You have unsaved edits.</span>
              <button type="button" className="v-btn" onClick={() => void load()}>
                Reload (discard edits)
              </button>
              <button type="button" className="v-btn" onClick={() => setBanner(null)}>
                Keep mine
              </button>
            </>
          )}
          {banner.type === 'deleted' && <span>This file was deleted on disk.</span>}
          {banner.type === 'error' && <span>Save failed: {banner.message}</span>}
        </div>
      )}
      {diff?.isNew && <div className="v-banner v-banner-info">Not in HEAD: showing the whole file as added.</div>}

      <div className="v-body">
        {text && editorShown && (
          <div className="v-fill" hidden={editorHidden}>
            <CodeEditor
              ref={editorRef}
              path={path}
              initialValue={previewText}
              readOnly={!editing}
              onChange={onDocChange}
              onSelection={(info) => active && onSelection(path, info)}
            />
          </div>
        )}
        {showPreview && <MarkdownPreview source={previewText} path={path} root={root} onOpenFile={onOpenFile} />}
        {text && diff && (
          <DiffView
            original={diff.original}
            modified={diff.modified}
            path={path}
            mode={diff.mode}
            editableModified={false}
          />
        )}
        {data.kind === 'image' && (svgMode === 'image' || !svg) && (
          <ImageView dataUrl={data.dataUrl} size={data.size} mime={data.mime} />
        )}
        {data.kind === 'image' && svg && svgMode === 'source' && (
          <pre className="v-svg-source">{data.svgSource}</pre>
        )}
        {data.kind === 'pdf' && <PdfView url={data.url} path={path} />}
        {data.kind === 'binary' && <Placeholder root={root} path={path} title="Binary file" size={data.size} />}
        {data.kind === 'tooLarge' && (
          <Placeholder root={root} path={path} title="File is too large to display" size={data.size} />
        )}
        {data.kind === 'error' && (
          <Placeholder root={root} path={path} title="Cannot open this file" detail={data.message} />
        )}
      </div>
    </div>
  );
});
