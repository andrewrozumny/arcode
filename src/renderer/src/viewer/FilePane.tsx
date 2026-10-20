import type { EditorView } from '@codemirror/view';
import type { ReadFileResult, SnapshotInfo } from '@shared/viewer';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { viewerApi } from './api';
import { AUTOSAVE_DELAY_MS, canAutosave, debounced } from './autosave';
import { CodeEditor } from './CodeEditor';
import type { CodeEditorHandle } from './CodeEditor';
import { DiffView } from './DiffView';
import type { DiffMode } from './DiffView';
import { formatDayTime } from '../format';
import { HistoryMenu, snapshotAge, sourceLabel } from './HistoryMenu';
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
  /**
   * Called before the tab closes. Starts a save when autosave may write and returns true; false
   * when unsaved edits would be lost (autosave off, or a banner waits for a decision).
   */
  saveBeforeClose(): boolean;
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
  /** The Autosave setting. */
  autosave: boolean;
  reveal: RevealRequest | null;
  /** A new value opens the diff with HEAD (the Changes view); null when none was asked for. */
  headDiff?: number | null;
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
  /** Set when the left side is a local history snapshot instead of HEAD. */
  snapshot?: SnapshotInfo;
}

const isMarkdown = (path: string): boolean => ['md', 'markdown', 'mdx'].includes(extension(path));

export const FilePane = forwardRef<FilePaneHandle, Props>(function FilePane(
  { root, path, active, autosave, reveal, headDiff, onDirtyChange, onSelection, onOpenFile },
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
  const [banner, setBannerState] = useState<Banner | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const mtimeRef = useRef<number | null>(null);
  const savedRef = useRef('');
  const dirtyRef = useRef(false);
  const bannerRef = useRef<Banner | null>(null);
  const appliedReveal = useRef(0);
  /** Last editor view seen by onDocChange: its state outlives the editor, so a save on unmount still has the text. */
  const lastViewRef = useRef<EditorView | null>(null);
  /** Saves run one after another so each one sends the mtime the previous one produced. */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const savesInFlight = useRef(0);
  /** A disk change reported while our own save was in flight; looked at again once it is done. */
  const deferredChange = useRef<{ mtime: number | null } | null>(null);
  const autosaveRef = useRef(autosave);
  const autosaveNowRef = useRef<() => void>(() => undefined);
  const onDiskChangeRef = useRef<(mtime: number | null) => void>(() => undefined);
  const [timer] = useState(() => debounced(() => autosaveNowRef.current(), AUTOSAVE_DELAY_MS));

  const setBanner = useCallback((value: Banner | null) => {
    bannerRef.current = value;
    setBannerState(value);
  }, []);

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
  }, [api, root, path, markDirty, setBanner]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.watchFile(root, path);
    const off = api.onFileChanged((event) => {
      if (event.root !== root || event.relPath !== path) return;
      // Our own write may be reported before its result arrives with the new mtime.
      if (savesInFlight.current > 0) {
        deferredChange.current = { mtime: event.mtime };
        return;
      }
      onDiskChangeRef.current(event.mtime);
    });
    return () => {
      off();
      void api.unwatchFile(root, path);
    };
  }, [api, root, path]);

  const onDiskChange = useCallback(
    (mtime: number | null) => {
      if (mtime === null) setBanner({ type: 'deleted' });
      else if (mtime === mtimeRef.current) return;
      else if (dirtyRef.current) setBanner({ type: 'external' });
      else void load();
    },
    [load, setBanner],
  );


  const currentText = useCallback(
    (): string | null => editorRef.current?.getValue() ?? lastViewRef.current?.state.doc.toString() ?? null,
    [],
  );

  const onDocChange = useCallback(
    (view: EditorView) => {
      lastViewRef.current = view;
      const doc = view.state.doc;
      markDirty(doc.length !== savedRef.current.length || doc.toString() !== savedRef.current);
      if (autosaveRef.current && dirtyRef.current) timer.schedule();
      else timer.cancel();
    },
    [markDirty, timer],
  );

  const writeText = useCallback(
    async (text: string, expectedOverride: number | null | undefined) => {
      // A save queued behind another may find the text already on disk.
      if (expectedOverride === undefined && text === savedRef.current) return;
      const expected = expectedOverride === undefined ? mtimeRef.current : expectedOverride;
      savesInFlight.current += 1;
      try {
        const result = await api.writeFile(root, path, text, expected);
        if (result.ok) {
          mtimeRef.current = result.mtime;
          savedRef.current = text;
          setPreviewText(text);
          setBanner(null);
          const now = currentText();
          markDirty(now !== null && now !== text);
        } else if (result.reason === 'conflict') {
          setBanner({ type: 'conflict' });
        } else {
          setBanner({ type: 'error', message: result.message });
        }
      } finally {
        savesInFlight.current -= 1;
        const deferred = deferredChange.current;
        if (savesInFlight.current === 0 && deferred) {
          deferredChange.current = null;
          onDiskChangeRef.current(deferred.mtime);
        }
      }
    },
    [api, root, path, markDirty, setBanner, currentText],
  );

  const save = useCallback(
    (expectedOverride?: number | null): Promise<void> => {
      timer.cancel();
      if (!dirtyRef.current && expectedOverride === undefined) return saveQueue.current;
      // Taken now, so a save started right before the tab closes still has the text.
      const text = currentText();
      if (text === null) return saveQueue.current;
      const run = saveQueue.current.then(() => writeText(text, expectedOverride));
      saveQueue.current = run.catch(() => undefined);
      return run;
    },
    [timer, writeText, currentText],
  );

  /** Saves now when autosave may write; otherwise does nothing. */
  const autosaveNow = useCallback(() => {
    timer.cancel();
    if (canAutosave({ enabled: autosaveRef.current, dirty: dirtyRef.current, banner: bannerRef.current !== null })) {
      void save();
    }
  }, [save, timer]);

  useEffect(() => {
    autosaveRef.current = autosave;
    autosaveNowRef.current = autosaveNow;
    onDiskChangeRef.current = onDiskChange;
  });

  // Turning autosave on with edits pending saves them; turning it off cancels a pending save.
  useEffect(() => {
    if (autosave) autosaveNowRef.current();
    else timer.cancel();
  }, [autosave, timer]);

  // Leaving the tab, the window losing focus and closing the window or tab all save.
  useEffect(() => {
    if (!active) autosaveNowRef.current();
  }, [active]);

  useEffect(() => {
    const flush = (): void => autosaveNowRef.current();
    window.addEventListener('blur', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);

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
    if (editing) autosaveNow();
    setEditing(!editing);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  }, [data, md, mdMode, showSource, editing, autosaveNow]);

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
    saveBeforeClose: () => {
      if (!dirtyRef.current) return true;
      if (!canAutosave({ enabled: autosaveRef.current, dirty: true, banner: bannerRef.current !== null })) return false;
      void save();
      return true;
    },
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

  const openHeadDiff = useCallback(
    async (mode: DiffMode): Promise<void> => {
      const head = await api.headContent(root, path);
      setDiff({
        mode,
        original: head ?? '',
        modified: editorRef.current?.getValue() ?? savedRef.current,
        isNew: head === null,
      });
    },
    [api, root, path],
  );

  // Apply an "open with its HEAD diff" request once the text is loaded.
  const appliedHeadDiff = useRef(0);
  useEffect(() => {
    if (!headDiff || data?.kind !== 'text' || headDiff === appliedHeadDiff.current) return;
    appliedHeadDiff.current = headDiff;
    void openHeadDiff('split');
  }, [headDiff, data, openHeadDiff]);

  const openSnapshotDiff = async (snapshot: SnapshotInfo): Promise<void> => {
    const content = await api.readSnapshot(root, path, snapshot.id);
    if (content === null) {
      setBanner({ type: 'error', message: 'This version is no longer in local history' });
      return;
    }
    setDiff({
      mode: diff?.mode ?? 'split',
      original: content,
      modified: editorRef.current?.getValue() ?? savedRef.current,
      isNew: false,
      snapshot,
    });
  };

  const restoreSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    const when = snapshotAge(snapshot);
    const question = dirtyRef.current
      ? `Restore the version from ${when}? Your unsaved edits are saved first, and the current file stays in local history.`
      : `Restore the version from ${when}? The current file stays in local history.`;
    if (!window.confirm(question)) return;
    if (dirtyRef.current) {
      await save();
      if (dirtyRef.current) return;
    }
    const result = await api.restoreSnapshot(root, path, snapshot.id, mtimeRef.current);
    if (result.ok) {
      setDiff(null);
      await load();
    } else {
      setBanner({
        type: 'error',
        message: result.reason === 'conflict' ? 'the file changed on disk meanwhile, try again' : result.message,
      });
    }
  };

  if (!data) return <div className="v-pane v-loading" />;

  const text = data.kind === 'text';
  const svg = data.kind === 'image' && data.svgSource !== undefined;
  const showPreview = text && md && mdMode === 'preview' && !diff;
  const editorHidden = !text || showPreview || diff !== null;
  const shownSnapshot = diff?.snapshot ?? null;

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
          <HistoryMenu
            root={root}
            path={path}
            selected={diff?.snapshot?.id ?? null}
            onPick={(snapshot) => void openSnapshotDiff(snapshot)}
          />
        )}
        {text && (
          <button
            type="button"
            className={diff && !diff.snapshot ? 'v-btn on' : 'v-btn'}
            title="Diff with HEAD"
            onClick={() => (diff && !diff.snapshot ? setDiff(null) : void openHeadDiff(diff?.mode ?? 'split'))}
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
      {shownSnapshot && (
        <div className="v-banner v-banner-info">
          <span>
            Left: local history from {formatDayTime(shownSnapshot.timestamp)} ({sourceLabel(shownSnapshot)}). Right: current file.
          </span>
          <span className="v-spacer" />
          <button type="button" className="v-btn" onClick={() => setDiff(null)}>
            Close
          </button>
          <button type="button" className="v-btn v-btn-primary" onClick={() => void restoreSnapshot(shownSnapshot)}>
            Restore this version
          </button>
        </div>
      )}

      <div className="v-body">
        {text && editorShown && (
          <div className="v-fill" hidden={editorHidden}>
            <CodeEditor
              ref={editorRef}
              path={path}
              initialValue={previewText}
              readOnly={!editing}
              onChange={onDocChange}
              onTypeToEdit={() => setEditing(true)}
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
