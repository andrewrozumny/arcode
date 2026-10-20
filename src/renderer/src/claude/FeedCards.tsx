import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FeedItem, FeedToolResult } from '@shared/claude';
import { modelLabel } from '../layout/ClaudeBadges';
import { openAgentTranscript } from './openFeed';
import { questionKeys } from './feedKeys';
import type { QuestionAnswer, ScreenPrompt } from './feedKeys';
import { runState } from './feedModel';
import type { FeedTask, RunState } from './feedModel';
import type { ToolItem } from './feedTools';
import { Chevron, Icon, Spinner } from './FeedIcons';
import { FeedMarkdown } from './FeedMarkdown';
import { TodoList, ToolRow, useFeedContext } from './FeedTool';
import type { PromptControl } from './useTerminalPrompt';

type Detail<T extends NonNullable<ToolItem['detail']>['type']> = Extract<NonNullable<ToolItem['detail']>, { type: T }>;

const AGENT_STATE: Record<RunState, string> = {
  running: 'Running',
  done: 'Finished',
  error: 'Failed',
  stopped: 'Stopped',
};

/** `haiku` or `claude-haiku-5-5` -> a readable model name. */
function modelName(model: string): string {
  if (/^claude-/.test(model)) return modelLabel(model);
  return model.charAt(0).toUpperCase() + model.slice(1);
}

function StatusPill({ state, labels }: { state: RunState; labels: Record<RunState, string> }) {
  return (
    <span className={`fd-pill ${state}`}>
      {state === 'running' ? <Spinner /> : state === 'done' ? <Icon name="check" /> : null}
      {labels[state]}
    </span>
  );
}

/** A subagent launch: type, model, description and whether it still runs; prompt and report on click. */
const AgentCard = memo(function AgentCard({ item, detail }: { item: ToolItem; detail: Detail<'agent'> }) {
  const { root, results, notices, activity, sessionId } = useFeedContext();
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const result = results[item.id];
  const notice = notices.get(item.id);
  const state = runState(item, result, notice, activity);
  const model = result?.agent?.model ?? detail.model;
  const report = notice?.result ?? (result && !result.agent?.async ? result.text : null);
  const openTranscript = (): void => {
    if (!sessionId) return;
    void openAgentTranscript(sessionId, { toolUseId: item.id, agentId: result?.agent?.agentId ?? null, title: detail.description }).then((ok) =>
      setMissing(!ok),
    );
  };
  return (
    <div className={`fd-card agent ${state}`}>
      <button type="button" className="fd-card-head" onClick={() => setOpen((v) => !v)}>
        <Icon name="agent" className="fd-card-icon" />
        <span className="fd-card-title">{detail.description}</span>
        <StatusPill state={state} labels={AGENT_STATE} />
        <Chevron open={open} />
      </button>
      <div className="fd-card-meta">
        <span className="fd-chip">{detail.agentType ?? 'agent'}</span>
        {model && <span className="fd-chip">{modelName(model)}</span>}
        {detail.background || result?.agent?.async ? <span className="fd-chip subtle">background</span> : null}
        {sessionId && (
          <button
            type="button"
            className="fd-card-link"
            onClick={openTranscript}
            title={missing ? 'No transcript for this agent yet' : "Open the agent's own conversation in a tab"}
          >
            {missing ? 'No transcript yet' : 'Open transcript'}
          </button>
        )}
      </div>
      {open && (
        <div className="fd-card-body">
          <div className="fd-label">Prompt</div>
          <div className="fd-quote">
            <FeedMarkdown text={detail.prompt || '(empty prompt)'} root={root} />
          </div>
          {report && (
            <>
              <div className="fd-label">Report</div>
              <FeedMarkdown text={report} root={root} />
            </>
          )}
          {result?.isError && <div className="fd-error-text">{result.text}</div>}
        </div>
      )}
    </div>
  );
});

/** The current task list: done items checked and struck through, the item in progress highlighted. */
function TaskCard({ tasks }: { tasks: readonly FeedTask[] }) {
  const done = tasks.filter((task) => task.status === 'completed').length;
  return (
    <div className="fd-card tasks">
      <div className="fd-card-head static">
        <Icon name="todo" className="fd-card-icon" />
        <span className="fd-card-title">Tasks</span>
        <span className="fd-card-count">
          {done} of {tasks.length} done
        </span>
      </div>
      <div className="fd-card-body">{tasks.length > 0 ? <TodoList tasks={tasks} /> : <div className="fd-muted">No tasks.</div>}</div>
    </div>
  );
}

/** Which options of a question the user picked, from the answer text. */
function picked(answer: string | undefined, label: string): boolean {
  if (!answer) return false;
  return answer === label || answer.split(/,\s*/).includes(label);
}

/** Answers from the result text when the structured answers are missing: `"question"="answer"`. */
function answersFromText(result: FeedToolResult | undefined): Record<string, string> {
  if (!result) return {};
  if (result.answers) return result.answers;
  const answers: Record<string, string> = {};
  for (const match of result.text.matchAll(/"([^"]+)"="([^"]*)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) answers[match[1]] = match[2];
  }
  return answers;
}

/** "Open terminal" and, once keys went out, a note; shared by the prompt cards. */
function PromptFooter({ control, children, note }: { control: PromptControl; children?: ReactNode; note?: string | null }) {
  return (
    <div className="fd-prompt-actions">
      {children}
      {control.ptyId !== null && (
        <button type="button" className="fd-btn" onClick={control.focusTerminal}>
          Open terminal
        </button>
      )}
      {control.sent && <span className="fd-muted">Sent to the terminal</span>}
      {note && <span className="fd-prompt-note">{note}</span>}
    </div>
  );
}

/** The options of a prompt on the terminal screen as buttons; each types its number. */
function ScreenOptions({ screen, control }: { screen: ScreenPrompt; control: PromptControl }) {
  return (
    <>
      <ul className="fd-options">
        {screen.options.map((option) => (
          <li key={option.key}>
            <button
              type="button"
              className="fd-option-btn"
              disabled={control.sent}
              title={option.needsText ? 'Pick this, then type in the terminal' : undefined}
              onClick={() => control.send([option.key], option.needsText)}
            >
              <span className="fd-option-mark">{option.key}</span>
              <span>
                <span className="fd-option-label">{option.label}</span>
                {option.needsText && <span className="fd-option-desc">Continues in the terminal</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <PromptFooter control={control} />
    </>
  );
}

/** A pending prompt this window cannot answer: point to the terminal. */
function TerminalHint({ control }: { control: PromptControl }) {
  return (
    <div className="fd-prompt-actions">
      <span className="fd-muted">Answer in the terminal.</span>
      {control.ptyId !== null && (
        <button type="button" className="fd-btn" onClick={control.focusTerminal}>
          Open terminal
        </button>
      )}
    </div>
  );
}

/**
 * Claude's questions to the user, with the options and, once answered, the picked ones. While
 * Claude waits on them the options are buttons: a lone single-choice question is answered with
 * one click, otherwise the picks are sent together.
 */
const QuestionCard = memo(function QuestionCard({ item, detail }: { item: ToolItem; detail: Detail<'question'> }) {
  const { results, prompt, activity } = useFeedContext();
  const result = results[item.id];
  const answers = answersFromText(result);
  const live = !result && prompt.pendingId === item.id && prompt.ptyId !== null;
  const [picks, setPicks] = useState<Record<number, number[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const questions = detail.questions;
  const lone = questions.length === 1 && questions[0]?.multiSelect === false;
  const disabled = !live || prompt.sent;

  const answerOf = (i: number, p = picks, t = typed): QuestionAnswer | undefined => {
    const text = t[i]?.trim();
    if (text) return { kind: 'other', text };
    const chosen = p[i];
    return chosen && chosen.length > 0 ? { kind: 'options', picks: chosen } : undefined;
  };
  const all = questions.map((_, i) => answerOf(i));
  const steps = live ? questionKeys(questions, all) : null;

  const submit = (list: (QuestionAnswer | undefined)[]): void => {
    const keys = questionKeys(questions, list);
    if (!keys || disabled) return;
    // Keys only mean the right thing on the first step of this question; else the terminal decides.
    if (!prompt.shows(questions[0]?.question ?? '')) {
      setNote('The terminal shows another step of this question. Answer it there.');
      prompt.focusTerminal();
      return;
    }
    setNote(null);
    prompt.send(keys);
  };

  const choose = (i: number, j: number): void => {
    const question = questions[i];
    if (!question || disabled) return;
    const current = picks[i] ?? [];
    const next = question.multiSelect ? (current.includes(j) ? current.filter((k) => k !== j) : [...current, j]) : [j];
    const nextPicks = { ...picks, [i]: next };
    const nextTyped = { ...typed, [i]: '' };
    setPicks(nextPicks);
    setTyped(nextTyped);
    if (lone) submit([answerOf(0, nextPicks, nextTyped)]);
  };

  // A question without an answer waits only while a Claude process runs the session.
  const pending = !result && activity !== 'gone';
  const pill = result
    ? result.isError
      ? 'Not answered'
      : 'Answered'
    : prompt.sent && live
      ? 'Answer sent'
      : pending
        ? 'Waiting for your answer'
        : 'Not answered';
  return (
    <div className={`fd-card ask${pending ? ' live' : ''}`}>
      <div className="fd-card-head static">
        <Icon name="question" className="fd-card-icon" />
        <span className="fd-card-title">{questions.length > 1 ? 'Questions for you' : 'Question for you'}</span>
        <span className={`fd-pill ${pending ? 'running' : !result || result.isError ? 'stopped' : 'done'}`}>{pill}</span>
      </div>
      <div className="fd-card-body">
        {questions.map((q, i) => {
          const answer = answers[q.question];
          const known = q.options.some((o) => picked(answer, o.label));
          const chosen = picks[i] ?? [];
          return (
            <div key={i} className="fd-question">
              {q.header && <span className="fd-chip">{q.header}</span>}
              <div className="fd-question-text">{q.question}</div>
              {q.multiSelect && live && <div className="fd-muted">Pick one or more.</div>}
              <ul className="fd-options">
                {q.options.map((option, j) => {
                  const done = picked(answer, option.label);
                  const on = live && chosen.includes(j);
                  const body = (
                    <>
                      <span className="fd-option-mark">{done || on ? <Icon name="check" /> : j + 1}</span>
                      <span>
                        <span className="fd-option-label">{option.label}</span>
                        {option.description && <span className="fd-option-desc">{option.description}</span>}
                      </span>
                    </>
                  );
                  return (
                    <li key={j} className={done ? 'picked' : on ? 'chosen' : undefined}>
                      {live ? (
                        <button type="button" className="fd-option-btn" disabled={disabled} aria-pressed={on} onClick={() => choose(i, j)}>
                          {body}
                        </button>
                      ) : (
                        body
                      )}
                    </li>
                  );
                })}
              </ul>
              {live && !q.multiSelect && (
                <input
                  className="fd-other"
                  type="text"
                  placeholder="Or type your own answer"
                  value={typed[i] ?? ''}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.target.value;
                    setTyped((t) => ({ ...t, [i]: value }));
                    if (value) setPicks((p) => ({ ...p, [i]: [] }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && lone) submit([answerOf(0)]);
                  }}
                />
              )}
              {live && q.multiSelect && <div className="fd-muted">To type your own answer, use the terminal.</div>}
              {answer && !known && <div className="fd-answer">Answer: {answer}</div>}
            </div>
          );
        })}
        {live && (
          <PromptFooter control={prompt} note={note}>
            {(!lone || Boolean(typed[0]?.trim())) && (
              <button type="button" className="fd-btn primary" disabled={disabled || !steps} onClick={() => submit(all)}>
                {questions.length > 1 ? 'Send answers' : 'Send answer'}
              </button>
            )}
          </PromptFooter>
        )}
        {!result && !live && prompt.pendingId === item.id && <TerminalHint control={prompt} />}
        {result?.isError && <div className="fd-muted fd-clamp">{result.text}</div>}
      </div>
    </div>
  );
});

/**
 * A plan Claude asks to approve, as Markdown, with the decision once made. While Claude waits on
 * it, the approval options the terminal shows are buttons.
 */
const PlanCard = memo(function PlanCard({ item, detail }: { item: ToolItem; detail: Detail<'plan'> }) {
  const { root, results, plans, prompt } = useFeedContext();
  const result = results[item.id];
  const text = plans.get(item.id) ?? detail.plan;
  const pending = !result && prompt.pendingId === item.id;
  const screen = pending && prompt.screen && isPlanPrompt(prompt.screen) ? prompt.screen : null;
  const status = !result ? (prompt.sent && pending ? 'Answer sent' : 'Awaiting approval') : result.isError ? 'Not approved' : 'Approved';
  return (
    <div className={`fd-card plan${!result ? ' live' : ''}`}>
      <div className="fd-card-head static">
        <Icon name="plan" className="fd-card-icon" />
        <span className="fd-card-title">Plan</span>
        <span className={`fd-pill ${!result ? 'running' : result.isError ? 'stopped' : 'done'}`}>{status}</span>
      </div>
      <div className="fd-card-body">
        <FeedMarkdown text={text || '(empty plan)'} root={root} />
        {screen && (
          <div className="fd-prompt">
            {screen.title && <div className="fd-question-text">{screen.title}</div>}
            <ScreenOptions screen={screen} control={prompt} />
          </div>
        )}
        {pending && !screen && <TerminalHint control={prompt} />}
        {result?.isError && <div className="fd-feedback">{result.text}</div>}
      </div>
    </div>
  );
});

/** True for the approval Claude Code shows after ExitPlanMode ("...a plan... Would you like to proceed?"). */
export function isPlanPrompt(screen: ScreenPrompt): boolean {
  return /\bplan\b/i.test(screen.title ?? '');
}

/**
 * A prompt Claude waits on that the transcript does not show yet, typically a permission: the
 * terminal's numbered options as buttons.
 */
export function PromptCard({ control }: { control: PromptControl }) {
  const screen = control.screen;
  if (!screen) return null;
  return (
    <div className="fd-card ask live prompt">
      <div className="fd-card-head static">
        <Icon name="question" className="fd-card-icon" />
        <span className="fd-card-title">{screen.title ?? 'Claude asks'}</span>
        <span className="fd-pill running">{control.sent ? 'Answer sent' : 'Waiting for you'}</span>
      </div>
      <div className="fd-card-body">
        <ScreenOptions screen={screen} control={control} />
      </div>
    </div>
  );
}

/** A tool call drawn as a card; `tasks` is the task list when the call is the latest list update. */
export function ToolCard({ item, tasks }: { item: ToolItem; tasks: readonly FeedTask[] }) {
  const detail = item.detail;
  switch (detail?.type) {
    case 'agent':
      return <AgentCard item={item} detail={detail} />;
    case 'question':
      return <QuestionCard item={item} detail={detail} />;
    case 'plan':
      return <PlanCard item={item} detail={detail} />;
    case 'todos':
    case 'task':
      return <TaskCard tasks={tasks} />;
    default:
      return <ToolRow item={item as Extract<FeedItem, { kind: 'tool' }>} />;
  }
}
