/**
 * Byte-range reads of one session transcript for the Claude feed. Transcripts grow to tens of
 * megabytes, so nothing here reads a whole file: the first load reads backwards from the end
 * until it has enough turns, live updates read only the bytes appended since the last read, and
 * "load earlier" reads backwards from the oldest byte the renderer has. Every read is capped.
 */
import { stat } from 'node:fs/promises';
import type { FeedChunk, FeedRequest } from '@shared/claude';
import { isRecord } from '@shared/guards';
import { integer, text } from '../ipcArgs';
import { emptyParsed, parseFeedLines, splitLines } from './feedParse';
import type { ParseOptions, ParsedFeed } from './feedParse';
import { findSessionTranscript, findSubagentTranscript, isAgentId, isSessionId, readBytes } from './transcripts';

/** Bytes read per step when reading backwards. */
const BACK_STEP = 256 * 1024;
/** Most bytes one backward read covers, however few turns it found. */
const BACK_MAX = 4 * 1024 * 1024;
/** A backward read stops once it has this many prompts and replies. */
const MIN_TURNS = 40;
/** Most bytes one forward (live) read covers; the renderer asks again right away when more is left. */
const FORWARD_MAX = 4 * 1024 * 1024;
const PATH_CACHE_LIMIT = 64;

/** How long a session without a transcript is not searched for again. */
const NOT_FOUND_TTL_MS = 5000;

/** Home, session id and agent id -> transcript path. Finding a transcript lists every project folder, so it is done once. */
const paths = new Map<string, string>();
/**
 * Home and session id -> time of the last search that found nothing. A new session polls before
 * its transcript exists; without this every poll would list every project folder again.
 */
const missing = new Map<string, number>();

async function locate(sessionId: string, agentId: string | undefined, home: string): Promise<{ path: string; size: number } | null> {
  const key = `${home}\0${sessionId}\0${agentId ?? ''}`;
  const cached = paths.get(key);
  if (cached) {
    const info = await stat(cached).catch(() => null);
    if (info?.isFile()) return { path: cached, size: info.size };
    paths.delete(key);
  }
  const missedAt = missing.get(key);
  if (missedAt !== undefined && Date.now() - missedAt < NOT_FOUND_TTL_MS) return null;
  const path = agentId === undefined ? await findSessionTranscript(sessionId, home) : await findSubagentTranscript(sessionId, agentId, home);
  if (!path) {
    if (missing.size >= PATH_CACHE_LIMIT) missing.clear();
    missing.set(key, Date.now());
    return null;
  }
  missing.delete(key);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (paths.size >= PATH_CACHE_LIMIT) paths.clear();
  paths.set(key, path);
  return { path, size: info.size };
}

function turns(parsed: ParsedFeed): number {
  return parsed.items.filter((item) => item.kind === 'user' || item.kind === 'assistant').length;
}

/**
 * Whole lines before `limit`, read backwards in steps until MIN_TURNS prompts and replies or
 * BACK_MAX bytes. `limit` may fall inside a line that is still being written; `end` is then the
 * start of that line.
 */
async function readBackward(file: string, limit: number, options: ParseOptions): Promise<{ start: number; end: number; parsed: ParsedFeed }> {
  const parsed = emptyParsed();
  let start = limit;
  let end: number | null = null;
  let step = BACK_STEP;
  while (start > 0 && limit - start < BACK_MAX && turns(parsed) < MIN_TURNS) {
    const from = Math.max(0, start - step);
    const split = splitLines(await readBytes(file, from, start - from), from, true);
    if (split.start === null || split.end === null || split.start >= start) {
      // No whole line starts in this step: it is inside one long line. Read a longer step so the
      // line is kept; past BACK_MAX give the line up and step over it.
      if (step < BACK_MAX) step *= 2;
      else {
        start = from;
        step = BACK_STEP;
      }
      continue;
    }
    step = BACK_STEP;
    end ??= split.end;
    const chunk = parseFeedLines(split.lines, options);
    parsed.items.unshift(...chunk.items);
    parsed.results.unshift(...chunk.results);
    parsed.usage.unshift(...chunk.usage);
    // Steps go backwards: the first step that saw a turn record saw the latest one.
    parsed.ended ??= chunk.ended;
    start = split.start;
  }
  return { start, end: end ?? start, parsed };
}

function chunk(size: number, start: number, end: number, parsed: ParsedFeed, reset = false): FeedChunk {
  return { found: true, size, start, end, reset, items: parsed.items, results: parsed.results, usage: parsed.usage, ended: parsed.ended };
}

/** Reads the part of a session transcript the request asks for. Missing transcripts give `found: false`. */
export async function readFeed(request: FeedRequest, home: string): Promise<FeedChunk> {
  const empty: FeedChunk = { found: false, size: 0, start: 0, end: 0, reset: false, items: [], results: [], usage: [], ended: null };
  if (!isSessionId(request.sessionId)) return empty;
  if (request.agentId !== undefined && !isAgentId(request.agentId)) return empty;
  const file = await locate(request.sessionId, request.agentId, home);
  if (!file) return empty;
  const { path, size } = file;
  // A subagent's transcript is all sidechain records; the session's own skips them.
  const options: ParseOptions = { sidechain: request.agentId !== undefined };

  if (request.from !== undefined) {
    if (request.from > size) {
      // The file was rewritten or replaced: start over from its tail.
      const tail = await readBackward(path, size, options);
      return chunk(size, tail.start, tail.end, tail.parsed, true);
    }
    const length = Math.min(size - request.from, FORWARD_MAX);
    if (length === 0) return chunk(size, request.from, request.from, emptyParsed());
    const split = splitLines(await readBytes(path, request.from, length), request.from, false);
    // A single line longer than FORWARD_MAX would stall live reads; skip what was read of it.
    const end = split.end === request.from && length === FORWARD_MAX ? request.from + length : (split.end ?? request.from);
    return chunk(size, request.from, end, parseFeedLines(split.lines, options));
  }

  const limit = request.before !== undefined ? Math.min(request.before, size) : size;
  const back = await readBackward(path, limit, options);
  return chunk(size, back.start, request.before !== undefined ? limit : back.end, back.parsed);
}

/** Checks a feed request arriving over IPC; throws on anything malformed. */
export function feedRequest(value: unknown): FeedRequest {
  if (!isRecord(value)) throw new Error('Invalid feed request');
  const sessionId = text(value.sessionId, 'session id');
  if (!isSessionId(sessionId)) throw new Error('Invalid session id');
  const request: FeedRequest = { sessionId };
  if (value.agentId !== undefined) {
    const agentId = text(value.agentId, 'agent id');
    if (!isAgentId(agentId)) throw new Error('Invalid agent id');
    request.agentId = agentId;
  }
  for (const key of ['from', 'before'] as const) {
    if (value[key] === undefined) continue;
    const offset = integer(value[key], key);
    if (offset < 0) throw new Error(`Invalid ${key}`);
    request[key] = offset;
  }
  return request;
}
