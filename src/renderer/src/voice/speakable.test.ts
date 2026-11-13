import { describe, expect, it } from 'vitest';
import { speakableText, speechChunks } from './speakable';

describe('speakableText', () => {
  it('drops code blocks and tables, keeps the prose', () => {
    const md = [
      'Готово, тесты проходят.',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Дальше добавлю проверку.',
    ].join('\n');
    expect(speakableText(md)).toBe('Готово, тесты проходят. Дальше добавлю проверку.');
  });

  it('leaves out paths, URLs and code-like inline spans', () => {
    const md = 'Поправил `listPasses()` в src/passes.ts:13 и `README.md`, см. https://example.com/x. Кнопка `Send` работает.';
    expect(speakableText(md)).toBe('Поправил в и, см. Кнопка Send работает.');
  });

  it('turns links, headings, lists and emphasis into plain sentences', () => {
    const md = '## Итог\n\n- **Первое** сделано\n- [второе](https://x.y) тоже\n> цитата';
    expect(speakableText(md)).toBe('Итог. Первое сделано. второе тоже. цитата.');
  });

  it('is empty for a code-only answer', () => {
    expect(speakableText('```\nls -la\n```')).toBe('');
  });
});

describe('speechChunks', () => {
  it('groups sentences up to the limit', () => {
    expect(speechChunks('One. Two. Three.', 9)).toEqual(['One. Two.', 'Three.']);
  });

  it('cuts a sentence longer than the limit', () => {
    expect(speechChunks('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});
