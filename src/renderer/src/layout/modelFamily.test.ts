import { describe, expect, it } from 'vitest';
import { modelFamily } from './modelFamily';

describe('modelFamily', () => {
  it('recognises the four families from ids', () => {
    expect(modelFamily('claude-fable-5-1')).toBe('fable');
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
    expect(modelFamily('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelFamily('claude-haiku-5-5')).toBe('haiku');
  });

  it('ignores case and provider prefixes, and reads display names', () => {
    expect(modelFamily('us.anthropic.claude-haiku-5-5-v1:0')).toBe('haiku');
    expect(modelFamily('Fable 5.1')).toBe('fable');
    expect(modelFamily('OPUS')).toBe('opus');
  });

  it('falls back to other', () => {
    expect(modelFamily('gpt-5')).toBe('other');
    expect(modelFamily('')).toBe('other');
  });
});
