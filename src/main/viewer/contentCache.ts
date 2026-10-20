/**
 * Bounded least recently used cache of file contents for local history: the last content ARcode
 * knows to be on disk, per absolute path. `null` means "known to be missing, binary or too large".
 * Bounded by an estimate of memory (two bytes per UTF-16 code unit) and by entry count, so watching
 * a busy project never holds more than a few dozen megabytes. No Electron imports.
 */

/** Memory budget of the whole cache, estimated as two bytes per character. */
export const CONTENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Most paths remembered at once (null entries cost no content but still take a slot). */
export const CONTENT_CACHE_MAX_ENTRIES = 10_000;

const costOf = (content: string | null): number => (content === null ? 0 : content.length * 2);

export class ContentCache {
  private readonly entries = new Map<string, { content: string | null; at: number }>();
  private used = 0;

  constructor(
    private readonly maxBytes = CONTENT_CACHE_MAX_BYTES,
    private readonly maxEntries = CONTENT_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The remembered content (marks it recently used), or undefined when nothing is known. */
  get(key: string): string | null | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.content;
  }

  /** Remembers `content`; content larger than the whole budget is forgotten instead. */
  set(key: string, content: string | null): void {
    this.delete(key);
    const cost = costOf(content);
    if (cost > this.maxBytes) return;
    this.entries.set(key, { content, at: this.now() });
    this.used += cost;
    while (this.used > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.used -= costOf(entry.content);
    this.entries.delete(key);
  }

  /** When `key` was last set, or undefined when nothing is known. */
  setAt(key: string): number | undefined {
    return this.entries.get(key)?.at;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Estimated memory held by the cached contents. */
  get bytes(): number {
    return this.used;
  }
}
