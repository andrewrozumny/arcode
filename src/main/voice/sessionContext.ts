/**
 * The session context of one window's discussion: digests of the Claude Code sessions it talked
 * about (in memory, a few at a time) and which brief the partner gets next. A full brief goes with
 * the first message, after the partner restarted or compacted its own context, when the user
 * switched to another session and when the transcript was rewritten; otherwise only what changed.
 */
import type { FeedChunk, FeedRequest } from '@shared/claude';
import { applyChunk, deltaBrief, emptyDigest, fullBrief, markSent, type SessionDigest } from './sessionBrief';
import { NO_SESSION } from './sessionTools';

/** Digests kept per window (switching back to a recent session is cheap). */
const KEEP_DIGESTS = 4;
/** Forward reads one brief takes to catch up (4 MB each). */
const CATCH_UP_READS = 6;
/** The first build reads earlier chunks until it has this many prompts. */
const FIRST_PROMPTS = 12;
const FIRST_READS = 3;

export type ReadFeed = (request: FeedRequest) => Promise<FeedChunk>;

export class SessionContext {
  private readonly digests = new Map<string, SessionDigest>();
  /** Session the last brief was about; undefined before the first one. */
  private sent: string | null | undefined = undefined;
  private full = true;
  /** Session of the latest message, for the lookup tools. */
  current: string | null = null;
  status: string | null = null;

  constructor(
    private readonly read: ReadFeed,
    private readonly root?: string,
  ) {}

  /** The next message's brief must be a full one (the partner restarted or compacted). */
  needFull(): void {
    this.full = true;
  }

  private async build(sessionId: string): Promise<SessionDigest | null> {
    let chunk = await this.read({ sessionId });
    if (!chunk.found) return null;
    const chunks = [chunk];
    const end = chunk.end;
    const prompts = (c: FeedChunk): number => c.items.filter((i) => i.kind === 'user').length;
    let count = prompts(chunk);
    for (let reads = 0; count < FIRST_PROMPTS && chunk.start > 0 && reads < FIRST_READS; reads++) {
      chunk = await this.read({ sessionId, before: chunk.start });
      chunks.unshift(chunk);
      count += prompts(chunk);
    }
    const digest = emptyDigest(sessionId);
    digest.earlier = chunk.start > 0;
    for (const c of chunks) applyChunk(digest, c.items, c.results, end);
    return digest;
  }

  /** Reads what the session appended since the digest; null when the transcript was rewritten. */
  private async advance(digest: SessionDigest): Promise<SessionDigest | null> {
    for (let reads = 0; reads < CATCH_UP_READS; reads++) {
      const chunk = await this.read({ sessionId: digest.sessionId, from: digest.offset });
      if (!chunk.found || chunk.reset) return null;
      if (chunk.end === digest.offset) break;
      applyChunk(digest, chunk.items, chunk.results, chunk.end);
      if (chunk.end >= chunk.size) break;
    }
    return digest;
  }

  private async digest(sessionId: string): Promise<{ digest: SessionDigest | null; fresh: boolean }> {
    const known = this.digests.get(sessionId);
    if (known) {
      this.digests.delete(sessionId);
      const advanced = await this.advance(known);
      if (advanced) {
        this.digests.set(sessionId, advanced);
        return { digest: advanced, fresh: false };
      }
    }
    const built = await this.build(sessionId);
    if (built) {
      this.digests.set(sessionId, built);
      while (this.digests.size > KEEP_DIGESTS) this.digests.delete(this.digests.keys().next().value ?? '');
    }
    return { digest: built, fresh: true };
  }

  /** The brief for the next message about `sessionId` (null: no Claude tab), with Claude Code's status. */
  async brief(sessionId: string | null, status: string | null, force = false): Promise<string> {
    const switched = this.sent !== undefined && this.sent !== sessionId;
    this.current = sessionId;
    this.status = status;
    if (!sessionId) {
      const repeat = this.sent === null && !this.full && !force;
      this.sent = null;
      this.full = false;
      return repeat ? '' : `<claude_code_session kind="none">\n${NO_SESSION}\n</claude_code_session>`;
    }
    const { digest, fresh } = await this.digest(sessionId);
    if (!digest) {
      this.sent = sessionId;
      return '<claude_code_session kind="none">\nThe Claude Code session in this window has no transcript yet (nothing was sent to Claude Code).\n</claude_code_session>';
    }
    const full = force || this.full || fresh || this.sent !== sessionId;
    const lead = switched ? 'The user switched to another Claude Code session; forget the previous one.' : undefined;
    const text = full ? fullBrief(digest, { status, ...(lead ? { lead } : {}), ...(this.root ? { root: this.root } : {}) }) : deltaBrief(digest, { status });
    markSent(digest);
    this.sent = sessionId;
    this.full = false;
    return text;
  }

  /** The full brief of the current session, for the session_brief tool (does not change what is sent next). */
  async currentBrief(): Promise<string> {
    if (!this.current) return NO_SESSION;
    const { digest } = await this.digest(this.current);
    if (!digest) return 'The session has no transcript yet.';
    return fullBrief(digest, { status: this.status, ...(this.root ? { root: this.root } : {}) });
  }
}
