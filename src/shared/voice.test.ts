import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCUSSION_MODEL, DISCUSSION_MODELS, discussionModelChoice } from './voice';

describe('discussionModelChoice', () => {
  it('accepts Sonnet and Opus', () => {
    expect(DISCUSSION_MODELS).toEqual(['sonnet', 'opus']);
    expect(discussionModelChoice('sonnet')).toBe('sonnet');
    expect(discussionModelChoice('opus')).toBe('opus');
  });

  it('falls back to Sonnet for anything else', () => {
    expect(DEFAULT_DISCUSSION_MODEL).toBe('sonnet');
    for (const value of ['haiku', 'Opus', 'claude-opus-5-5', '--model x', '', null, undefined, 5, {}]) {
      expect(discussionModelChoice(value)).toBe('sonnet');
    }
  });
});
