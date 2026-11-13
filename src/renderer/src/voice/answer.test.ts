import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@shared/claude';
import { dictationText, turnAnswer } from './answer';

let n = 0;
const item = (body: Record<string, unknown>): FeedItem => ({ id: String(n++), at: null, offset: n, ...body }) as FeedItem;

describe('turnAnswer', () => {
  it('takes the last assistant text after the last prompt', () => {
    const items = [
      item({ kind: 'user', text: 'old', images: 0 }),
      item({ kind: 'assistant', text: 'old answer' }),
      item({ kind: 'user', text: 'run tests', images: 0 }),
      item({ kind: 'assistant', text: 'Let me check.' }),
      item({ kind: 'tool', name: 'Bash', summary: 'pnpm test', input: '', detail: null }),
      item({ kind: 'assistant', text: 'All 12 tests pass.' }),
    ];
    expect(turnAnswer(items)).toBe('All 12 tests pass.');
  });

  it('is null when the turn has no text yet', () => {
    expect(turnAnswer([item({ kind: 'assistant', text: 'x' }), item({ kind: 'user', text: 'y', images: 0 })])).toBeNull();
    expect(turnAnswer([])).toBeNull();
  });
});

describe('dictationText', () => {
  it('joins later phrases with a space', () => {
    expect(dictationText('Привет', false)).toBe('Привет');
    expect(dictationText('мир', true)).toBe(' мир');
  });
});
