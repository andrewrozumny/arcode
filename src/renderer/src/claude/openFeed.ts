import { bus } from '../bus';
import { claudeApi } from './api';
import { feedTabTitle } from './panelModel';

/** Opens a read-only feed tab for a past (or running) session. */
export function openSessionFeed(sessionId: string, title: string): void {
  bus.emit('openFeed', { sessionId, title: feedTabTitle(title) });
}

/**
 * Opens a feed tab for a subagent of `sessionId`. The agent id comes from the Agent call's result
 * when it has one; a call that is still running has no result yet, so the agent is looked up by
 * the call's tool_use id in the session's subagent list. False when no transcript is found.
 */
export async function openAgentTranscript(
  sessionId: string,
  agent: { agentId: string | null; toolUseId: string | null; title: string },
): Promise<boolean> {
  let agentId = agent.agentId;
  if (!agentId && agent.toolUseId) {
    const list = await claudeApi()
      .subagents(sessionId)
      .catch(() => []);
    agentId = list.find((a) => a.toolUseId === agent.toolUseId)?.id ?? null;
  }
  if (!agentId) return false;
  bus.emit('openFeed', { sessionId, agentId, title: feedTabTitle(`Agent: ${agent.title}`) });
  return true;
}
