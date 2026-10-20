import { useEffect, useRef, useState } from 'react';
import type { SubagentInfo } from '@shared/claude';
import { openAgentTranscript } from '../claude/openFeed';
import type { BadgeModel } from '../claude/liveUsage';
import { shortAge } from '../format';
import { modelFamily } from './modelFamily';

/** `claude-opus-5-5` -> `Opus 5.5`; unknown shapes are shown as they are. */
export function modelLabel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (!match?.[1]) return id;
  const family = match[1];
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`;
}

export function ModelBadge({ model }: { model: BadgeModel }) {
  return (
    <span className={`model-badge family-${modelFamily(model.id)}`} title={model.id}>
      {model.name ?? modelLabel(model.id)}
    </span>
  );
}

function agentName(agent: SubagentInfo): string {
  return agent.label ?? agent.agentType ?? agent.id;
}

function agentModel(agent: SubagentInfo): string {
  return agent.modelName ?? (agent.model ? modelLabel(agent.model) : 'model unknown');
}

/**
 * `⤷ 2 agents` with one family-coloured dot per running subagent; the tooltip names them. A click
 * lists them, each with "Open transcript" when the session is known.
 */
export function AgentsChip({ agents, sessionId = null }: { agents: readonly SubagentInfo[]; sessionId?: string | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const title = agents.map((a) => `${agentName(a)} · ${agentModel(a)} · ${shortAge(a.startedAt)}`).join('\n');

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="agents-chip-wrap" ref={rootRef}>
      <button type="button" className="agents-chip" title={open ? undefined : title} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="agents-chip-dots" aria-hidden="true">
          {agents.map((a) => (
            <span key={a.id} className={`agents-chip-dot model-family-${a.model ? modelFamily(a.model) : 'other'}`} />
          ))}
        </span>
        ⤷ {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
      </button>
      {open && (
        <span className="agents-menu" role="menu">
          {agents.map((a) => (
            <span key={a.id} className="agents-menu-row">
              <span className={`agents-chip-dot model-family-${a.model ? modelFamily(a.model) : 'other'}`} aria-hidden="true" />
              <span className="agents-menu-name" title={agentName(a)}>
                {agentName(a)}
              </span>
              <span className="agents-menu-meta">
                {agentModel(a)} · {shortAge(a.startedAt)}
              </span>
              {sessionId && (
                <button
                  type="button"
                  className="agents-menu-open"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    void openAgentTranscript(sessionId, { agentId: a.id, toolUseId: a.toolUseId, title: agentName(a) });
                  }}
                >
                  Open transcript
                </button>
              )}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
