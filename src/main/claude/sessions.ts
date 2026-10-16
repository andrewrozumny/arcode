import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionSummary } from '@shared/claude';
import { mapLimit } from '../concurrency';
import { isRecord } from './common';
import { isSessionId, parseJsonLine, projectDir } from './transcripts';

/** Most sessions the list shows; older transcripts are not read at all. */
export const MAX_SESSIONS = 200;
const PROMPT_CHARS = 160;
/** Files stat'ed or read at the same time. */
const READ_CONCURRENCY = 8;

/** Text of a user message: a plain string, or the text blocks of a content array (tool results have none). */
function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** Collapses whitespace and trims to a list-friendly length. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_CHARS ? `${flat.slice(0, PROMPT_CHARS - 1)}…` : flat;
}

export interface ParsedTranscript {
  firstPrompt: string | null;
  startedAt: string | null;
  messages: number;
}

/**
 * Reads a transcript (JSON Lines). The first typed prompt is the first user entry that is not
 * meta and does not start with `<`: Claude Code writes slash commands and their output as user
 * entries wrapped in tags, and those are not what the user recognises the session by.
 */
export function parseTranscript(text: string): ParsedTranscript {
  let firstPrompt: string | null = null;
  let startedAt: string | null = null;
  let messages = 0;
  for (const line of text.split('\n')) {
    const record = parseJsonLine(line);
    if (!record) continue;
    if (startedAt === null && typeof record.timestamp === 'string') startedAt = record.timestamp;
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    messages++;
    if (firstPrompt !== null || record.type !== 'user' || record.isMeta === true) continue;
    const body = isRecord(record.message) ? messageText(record.message.content) : null;
    if (body === null) continue;
    const trimmed = body.trim();
    if (trimmed === '' || trimmed.startsWith('<')) continue;
    firstPrompt = snippet(trimmed);
  }
  return { firstPrompt, startedAt, messages };
}

interface Candidate {
  id: string;
  file: string;
  mtime: number;
}

async function readCandidate(file: string): Promise<ParsedTranscript | null> {
  try {
    return parseTranscript(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Past sessions of a project, newest first. Only transcripts with a typed prompt are listed,
 * because a session without one has nothing to resume. Transcripts are read newest first, a few
 * at a time, and reading stops once MAX_SESSIONS sessions are found.
 */
export async function listSessions(root: string, home: string): Promise<SessionSummary[]> {
  const dir = await projectDir(root, home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const ids = names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .filter(isSessionId);
  const stated = await mapLimit(ids, READ_CONCURRENCY, async (id): Promise<Candidate | null> => {
    const file = join(dir, `${id}.jsonl`);
    try {
      return { id, file, mtime: (await stat(file)).mtimeMs };
    } catch {
      return null; // Removed between readdir and stat.
    }
  });
  const candidates = stated.filter((c): c is Candidate => c !== null).sort((a, b) => b.mtime - a.mtime);

  const out: SessionSummary[] = [];
  for (let start = 0; start < candidates.length && out.length < MAX_SESSIONS; start += READ_CONCURRENCY) {
    const batch = candidates.slice(start, start + READ_CONCURRENCY);
    const parsed = await mapLimit(batch, READ_CONCURRENCY, (candidate) => readCandidate(candidate.file));
    batch.forEach((candidate, index) => {
      const transcript = parsed[index];
      if (out.length >= MAX_SESSIONS || !transcript || transcript.firstPrompt === null) return;
      out.push({
        sessionId: candidate.id,
        firstPrompt: transcript.firstPrompt,
        startedAt: transcript.startedAt,
        lastActiveAt: new Date(candidate.mtime).toISOString(),
        messages: transcript.messages,
      });
    });
  }
  return out;
}
