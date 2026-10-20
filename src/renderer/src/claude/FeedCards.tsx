import { memo, useState } from 'react';
import type { FeedItem, FeedToolResult } from '@shared/claude';
import { modelLabel } from '../layout/ClaudeBadges';
import { openAgentTranscript } from './openFeed';
import { runState } from './feedModel';
import type { FeedTask, RunState } from './feedModel';
import type { ToolItem } from './feedTools';
import { Chevron, Icon, Spinner } from './FeedIcons';
import { FeedMarkdown } from './FeedMarkdown';
import { TodoList, ToolRow, useFeedContext } from './FeedTool';

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

/** Claude's questions to the user, with the options and, once answered, the picked ones. */
const QuestionCard = memo(function QuestionCard({ item, detail }: { item: ToolItem; detail: Detail<'question'> }) {
  const { results, activity } = useFeedContext();
  const result = results[item.id];
  const answers = answersFromText(result);
  // A question without an answer waits only while a Claude process runs the session.
  const pending = !result && activity !== 'gone';
  const status = pending ? 'Waiting for your answer' : !result || result.isError ? 'Not answered' : 'Answered';
  return (
    <div className={`fd-card ask${pending ? ' live' : ''}`}>
      <div className="fd-card-head static">
        <Icon name="question" className="fd-card-icon" />
        <span className="fd-card-title">{detail.questions.length > 1 ? 'Questions for you' : 'Question for you'}</span>
        <span className={`fd-pill ${pending ? 'running' : !result || result.isError ? 'stopped' : 'done'}`}>{status}</span>
      </div>
      <div className="fd-card-body">
        {detail.questions.map((q, i) => {
          const answer = answers[q.question];
          const known = q.options.some((o) => picked(answer, o.label));
          return (
            <div key={i} className="fd-question">
              {q.header && <span className="fd-chip">{q.header}</span>}
              <div className="fd-question-text">{q.question}</div>
              <ul className="fd-options">
                {q.options.map((option, j) => (
                  <li key={j} className={picked(answer, option.label) ? 'picked' : undefined}>
                    <span className="fd-option-mark">{picked(answer, option.label) ? <Icon name="check" /> : j + 1}</span>
                    <span>
                      <span className="fd-option-label">{option.label}</span>
                      {option.description && <span className="fd-option-desc">{option.description}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {answer && !known && <div className="fd-answer">Answer: {answer}</div>}
            </div>
          );
        })}
        {result?.isError && <div className="fd-muted fd-clamp">{result.text}</div>}
      </div>
    </div>
  );
});

/** A plan Claude asks to approve, as Markdown, with the decision once made. */
const PlanCard = memo(function PlanCard({ item, detail }: { item: ToolItem; detail: Detail<'plan'> }) {
  const { root, results } = useFeedContext();
  const result = results[item.id];
  const status = !result ? 'Awaiting approval' : result.isError ? 'Not approved' : 'Approved';
  return (
    <div className={`fd-card plan${!result ? ' live' : ''}`}>
      <div className="fd-card-head static">
        <Icon name="plan" className="fd-card-icon" />
        <span className="fd-card-title">Plan</span>
        <span className={`fd-pill ${!result ? 'running' : result.isError ? 'stopped' : 'done'}`}>{status}</span>
      </div>
      <div className="fd-card-body">
        <FeedMarkdown text={detail.plan || '(empty plan)'} root={root} />
        {result?.isError && <div className="fd-feedback">{result.text}</div>}
      </div>
    </div>
  );
});

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
