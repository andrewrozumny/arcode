import { createContext, memo, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FeedTaskNotice, FeedToolResult } from '@shared/claude';
import { bus } from '../bus';
import { addedRows, diffLines, patchRows, withContext } from './feedDiff';
import type { DiffRow } from './feedDiff';
import { runState, toolGroupState } from './feedModel';
import type { RunState, SessionActivity } from './feedModel';
import { phraseText, toolGroupLabel, toolPhrase } from './feedTools';
import type { ToolItem, ToolPhrase } from './feedTools';
import { Chevron, Icon, Spinner } from './FeedIcons';
import { CodeBlock } from './FeedMarkdown';

/** What every tool row and card needs besides its own item. */
export interface FeedContextValue {
  root: string;
  results: Record<string, FeedToolResult>;
  notices: Map<string, FeedTaskNotice>;
  activity: SessionActivity;
  /** Session whose transcript (or whose subagent's transcript) is shown; null when none. */
  sessionId: string | null;
  /**
   * True only in the pinned feed, which shows the session live in this window. Read-only tabs of
   * past sessions and subagents never offer actions that would answer Claude.
   */
  interactive: boolean;
}

export const FeedContext = createContext<FeedContextValue>({
  root: '',
  results: {},
  notices: new Map(),
  activity: 'unknown',
  sessionId: null,
  interactive: false,
});

export function useFeedContext(): FeedContextValue {
  return useContext(FeedContext);
}

/** Output lines shown before "Show more". */
const OUTPUT_LINES = 14;
/** Diff rows shown before "Show all". */
const DIFF_ROWS = 160;

/** `/repo/src/a.ts` -> `src/a.ts` inside the project, else the path as it is. */
export function projectPath(root: string, path: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** A path that opens in the viewer when it lies inside the project. */
export function PathLink({ path, line, children }: { path: string; line?: number | undefined; children?: ReactNode }) {
  const { root } = useFeedContext();
  const base = root.endsWith('/') ? root : `${root}/`;
  const shown = children ?? projectPath(root, path);
  if (!path.startsWith(base)) return <span className="fd-path">{shown}</span>;
  return (
    <button
      type="button"
      className="fd-path link"
      title={line !== undefined ? `${path}:${line}` : path}
      onClick={(event) => {
        event.stopPropagation();
        bus.openFile(line !== undefined ? { path, line } : { path });
      }}
    >
      {shown}
    </button>
  );
}

/** Long text in monospace, cut to OUTPUT_LINES until expanded. */
export function Output({ text, error, label }: { text: string; error?: boolean; label?: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > OUTPUT_LINES || text.length > 4000;
  const shown = all || !long ? text : lines.slice(0, OUTPUT_LINES).join('\n').slice(0, 4000);
  return (
    <div className="fd-output">
      {label && <div className="fd-label">{label}</div>}
      <pre className={`fd-pre out${error ? ' error' : ''}`}>{shown || '(no output)'}</pre>
      {long && (
        <button type="button" className="fd-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show more (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

function DiffView({ rows, numbered }: { rows: DiffRow[]; numbered: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, DIFF_ROWS);
  return (
    <div className="fd-diff-wrap">
      <div className={`fd-diff${numbered ? ' numbered' : ''}`}>
        {shown.map((row, i) =>
          row.kind === 'gap' ? (
            <div key={i} className="fd-diff-gap">⋯</div>
          ) : (
            <div key={i} className={`fd-diff-line ${row.kind}`}>
              {numbered && <span className="fd-diff-num">{row.line ?? ''}</span>}
              <span className="fd-diff-mark">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}</span>
              <span className="fd-diff-text">{row.text || ' '}</span>
            </div>
          ),
        )}
      </div>
      {rows.length > DIFF_ROWS && (
        <button type="button" className="fd-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all ${rows.length} lines`}
        </button>
      )}
    </div>
  );
}

/** Rows of an edit or write: the reported patch when there is one, else computed from the input. */
export function editRows(item: ToolItem, result: FeedToolResult | undefined): { rows: DiffRow[]; numbered: boolean } {
  const detail = item.detail;
  if (result?.patch && result.patch.length > 0) return { rows: patchRows(result.patch), numbered: true };
  if (detail?.type === 'write') return { rows: addedRows(detail.content), numbered: true };
  if (detail?.type !== 'edit') return { rows: [], numbered: false };
  const rows: DiffRow[] = [];
  detail.edits.forEach((edit, i) => {
    if (i > 0) rows.push({ kind: 'gap' });
    rows.push(...withContext(diffLines(edit.oldText, edit.newText)));
  });
  return { rows, numbered: false };
}

function Stats({ phrase }: { phrase: ToolPhrase }) {
  if (phrase.added === undefined) return null;
  return (
    <span className="fd-stats">
      <span className="add">+{phrase.added}</span>
      <span className="del">-{phrase.removed ?? 0}</span>
    </span>
  );
}

function ToolDetail({ item, result }: { item: ToolItem; result: FeedToolResult | undefined }) {
  const detail = item.detail;
  const errorOut = result?.isError ? <Output text={result.text} error /> : null;
  switch (detail?.type) {
    case 'bash':
      return (
        <div className="fd-detail">
          <div className="fd-bash">
            <div className="fd-bash-head">
              <strong>Bash</strong>
              {detail.description && <span className="fd-muted">{detail.description}</span>}
              {detail.background && <span className="fd-chip subtle">background</span>}
            </div>
            <CodeBlock code={detail.command} lang="bash" className="cmd" />
          </div>
          {result ? <Output text={result.text} error={result.isError} /> : <div className="fd-muted">No output yet.</div>}
        </div>
      );
    case 'edit':
    case 'write': {
      const { rows, numbered } = editRows(item, result);
      return (
        <div className="fd-detail">
          <div className="fd-kv">
            <PathLink path={detail.path} line={firstLine(rows)} />
          </div>
          {rows.length > 0 ? <DiffView rows={rows} numbered={numbered} /> : <div className="fd-muted">No changes.</div>}
          {errorOut}
        </div>
      );
    }
    case 'read': {
      const from = detail.offset ?? 1;
      const range =
        detail.offset !== null || detail.limit !== null
          ? `Lines ${from}-${detail.limit !== null ? from + detail.limit - 1 : 'end'}`
          : 'Whole file';
      const total = result?.lines ? `${result.lines.count} lines read${result.lines.total !== null ? ` of ${result.lines.total}` : ''}` : null;
      return (
        <div className="fd-detail">
          <div className="fd-kv">
            <PathLink path={detail.path} line={detail.offset ?? undefined} />
            <span className="fd-muted">
              {range}
              {total ? ` · ${total}` : ''}
            </span>
          </div>
          {errorOut}
        </div>
      );
    }
    case 'search':
      return (
        <div className="fd-detail">
          <div className="fd-kv">
            <code className="fd-inline">{detail.pattern}</code>
            {detail.path && (
              <span className="fd-muted">
                in <PathLink path={detail.path} />
              </span>
            )}
            {detail.glob && <span className="fd-muted">({detail.glob})</span>}
            {result?.matches && (
              <span className="fd-muted">
                · {result.matches.count} {result.matches.unit === 'lines' ? 'matching lines' : 'files'}
              </span>
            )}
          </div>
          {result && <Output text={result.text} error={result.isError} />}
        </div>
      );
    case 'web':
      return (
        <div className="fd-detail">
          <div className="fd-kv">
            {detail.url ? (
              <a
                className="fd-weblink"
                href={detail.url}
                onClick={(event) => {
                  event.preventDefault();
                  window.open(detail.url ?? '');
                }}
              >
                {detail.url}
              </a>
            ) : (
              <span>{detail.query}</span>
            )}
          </div>
          {detail.prompt && <div className="fd-label">{detail.prompt}</div>}
          {result && <Output text={result.text} error={result.isError} />}
        </div>
      );
    case 'todos':
      return (
        <div className="fd-detail">
          <TodoList tasks={detail.todos.map((t, i) => ({ id: String(i), subject: t.content, status: t.status, activeForm: t.activeForm }))} />
        </div>
      );
    default:
      return (
        <div className="fd-detail">
          {item.input && item.input !== '{}' && <CodeBlock code={item.input} lang="json" />}
          {result ? <Output text={result.text} error={result.isError} /> : <div className="fd-muted">No result yet.</div>}
        </div>
      );
  }
}

function firstLine(rows: DiffRow[]): number | undefined {
  for (const row of rows) if (row.kind !== 'gap' && row.kind !== 'removed' && row.line !== null) return row.line;
  return undefined;
}

export interface TodoEntry {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string | null;
}

export function TodoList({ tasks }: { tasks: readonly TodoEntry[] }) {
  return (
    <ul className="fd-todos">
      {tasks.map((task) => (
        <li key={task.id} className={`fd-todo ${task.status}`}>
          <span className="fd-todo-box">{task.status === 'completed' ? <Icon name="check" /> : null}</span>
          <span className="fd-todo-text">{task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}</span>
        </li>
      ))}
    </ul>
  );
}

function StateMark({ state, icon }: { state: RunState; icon: ToolPhrase['icon'] }) {
  if (state === 'running') return <span className="fd-mark running"><Spinner /></span>;
  return (
    <span className={`fd-mark ${state}`}>
      <Icon name={icon} />
    </span>
  );
}

function PhraseText({ phrase }: { phrase: ToolPhrase }) {
  return (
    <span className="fd-phrase">
      <span className="fd-verb">{phrase.verb}</span>
      {phrase.target && (phrase.code ? <code className="fd-target code">{phrase.target}</code> : <span className="fd-target">{phrase.target}</span>)}
      {phrase.note && <span className="fd-note">{phrase.note}</span>}
    </span>
  );
}

/** One tool call: icon, phrase and state; the details open on click. */
export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const { results, notices, activity } = useFeedContext();
  const result = results[item.id];
  const [open, setOpen] = useState(false);
  const state = runState(item, result, notices.get(item.id), activity);
  const phrase = useMemo(() => toolPhrase(item, result, state === 'running'), [item, result, state]);
  return (
    <div className={`fd-tool ${state}${open ? ' open' : ''}`}>
      <button type="button" className="fd-row" onClick={() => setOpen((v) => !v)} title={phraseText(phrase)}>
        <StateMark state={state} icon={phrase.icon} />
        <PhraseText phrase={phrase} />
        <Stats phrase={phrase} />
        {state === 'error' && <span className="fd-badge error">Failed</span>}
        {state === 'stopped' && <span className="fd-badge">Stopped</span>}
        <Chevron open={open} />
      </button>
      {open && <ToolDetail item={item} result={result} />}
    </div>
  );
});

/** A run of tool calls as one row, "Read 3 files, ran 2 commands"; a single call is a plain row. */
export function ToolGroup({ items }: { items: ToolItem[] }) {
  const { results, notices, activity } = useFeedContext();
  const [open, setOpen] = useState(false);
  const first = items[0];
  const label = useMemo(() => toolGroupLabel(items), [items]);
  if (items.length === 1 && first) return <ToolRow item={first} />;
  const state = toolGroupState(items.map((item) => runState(item, results[item.id], notices.get(item.id), activity)));
  return (
    <div className={`fd-tool group ${state}${open ? ' open' : ''}`}>
      <button type="button" className="fd-row" onClick={() => setOpen((v) => !v)}>
        <span className="fd-mark lead">
          <Chevron open={open} />
        </span>
        <span className="fd-phrase">
          <span className="fd-verb">{label}</span>
        </span>
        {state === 'running' && (
          <span className="fd-mark running">
            <Spinner />
          </span>
        )}
        {state === 'error' && <span className="fd-badge error">Some failed</span>}
      </button>
      {open && (
        <div className="fd-group-list">
          {items.map((item) => (
            <div key={item.id} className="fd-branch">
              <ToolRow item={item} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
