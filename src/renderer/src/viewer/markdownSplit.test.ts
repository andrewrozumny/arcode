import { describe, expect, it } from 'vitest';
import { markedWithLines } from './markdown';
import {
  blockStartLines,
  buildAnchors,
  clampFraction,
  lineForTop,
  loadMarkdownMode,
  loadSplitFraction,
  saveMarkdownMode,
  topForLine,
  withSourceLine,
} from './markdownSplit';

function memoryStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe('blockStartLines', () => {
  it('counts newlines of the preceding tokens', () => {
    expect(blockStartLines([{ raw: '# A' }, { raw: '\n\n' }, { raw: 'p1\np2' }, { raw: '\n\n' }, { raw: '- x' }])).toEqual([
      1, 3, 3, 6, 6,
    ]);
  });

  it('skips leading newlines inside a token', () => {
    expect(blockStartLines([{ raw: 'a\n' }, { raw: '\n\nb' }])).toEqual([1, 4]);
  });
});

describe('withSourceLine', () => {
  it('marks the first opening tag', () => {
    expect(withSourceLine('<h1 id="x">T</h1>\n', 3)).toBe('<h1 data-line="3" id="x">T</h1>\n');
    expect(withSourceLine('<p>a</p><p>b</p>', 7)).toBe('<p data-line="7">a</p><p>b</p>');
    expect(withSourceLine('<hr>', 2)).toBe('<hr data-line="2">');
  });

  it('leaves text and comments alone', () => {
    expect(withSourceLine('plain', 1)).toBe('plain');
    expect(withSourceLine('<!-- c -->', 1)).toBe('<!-- c -->');
  });
});

describe('markedWithLines', () => {
  it('puts source lines on top-level blocks', () => {
    const src = '# Title\n\nPara one\nstill para\n\n[ref]: https://x.test\n\n- a\n- b\n\n```js\ncode\n```\n\n> quote [r][ref]\n';
    const html = markedWithLines(src);
    expect(html).toContain('<h1 data-line="1">');
    expect(html).toContain('<p data-line="3">');
    expect(html).toContain('<ul data-line="8">');
    expect(html).toContain('<pre data-line="11">');
    expect(html).toContain('<blockquote data-line="15">');
    // Link references defined elsewhere in the document still resolve.
    expect(html).toContain('href="https://x.test"');
  });

  it('handles CRLF sources', () => {
    expect(markedWithLines('a\r\n\r\nb\r\n')).toContain('<p data-line="3">b</p>');
  });
});

describe('anchors', () => {
  const anchors = buildAnchors(
    [
      { line: 5, top: 100 },
      { line: 10, top: 300 },
    ],
    19,
    700,
  );

  it('adds start and end anchors', () => {
    expect(anchors).toEqual([
      { line: 1, top: 0 },
      { line: 5, top: 100 },
      { line: 10, top: 300 },
      { line: 20, top: 700 },
    ]);
  });

  it('maps a line to the nearest block, interpolating inside it', () => {
    expect(topForLine(anchors, 5)).toBe(100);
    expect(topForLine(anchors, 7.5)).toBe(200);
    expect(topForLine(anchors, 3)).toBe(50);
    expect(topForLine(anchors, 15)).toBe(500);
    expect(topForLine(anchors, 0)).toBe(0);
    expect(topForLine(anchors, 99)).toBe(700);
  });

  it('maps an offset back to a line', () => {
    expect(lineForTop(anchors, 100)).toBe(5);
    expect(lineForTop(anchors, 200)).toBe(7.5);
    expect(lineForTop(anchors, 500)).toBe(15);
    expect(lineForTop(anchors, -10)).toBe(1);
    expect(lineForTop(anchors, 9999)).toBe(20);
  });

  it('falls back to a line ratio without blocks', () => {
    const ratio = buildAnchors([], 100, 1000);
    expect(topForLine(ratio, 51)).toBe(500);
    expect(lineForTop(ratio, 250)).toBe(26);
  });

  it('drops blocks that would make the mapping go backwards', () => {
    const odd = buildAnchors(
      [
        { line: 8, top: 50 },
        { line: 4, top: 200 },
        { line: 6, top: 40 },
        { line: Number.NaN, top: 10 },
      ],
      9,
      300,
    );
    expect(odd).toEqual([
      { line: 1, top: 0 },
      { line: 4, top: 200 },
      { line: 10, top: 300 },
    ]);
  });

  it('lets a block on line 1 move the start anchor', () => {
    expect(buildAnchors([{ line: 1, top: 24 }], 4, 100)[0]).toEqual({ line: 1, top: 24 });
  });
});

describe('remembered mode', () => {
  it('defaults to Preview and remembers per extension', () => {
    const storage = memoryStorage();
    expect(loadMarkdownMode(storage, 'md')).toBe('preview');
    saveMarkdownMode(storage, 'md', 'split');
    expect(loadMarkdownMode(storage, 'md')).toBe('split');
    expect(loadMarkdownMode(storage, 'mdx')).toBe('preview');
  });

  it('ignores junk and broken storage', () => {
    const storage = memoryStorage();
    storage.setItem('arcode.viewer.markdownMode.md', 'weird');
    expect(loadMarkdownMode(storage, 'md')).toBe('preview');
    const throwing = {
      getItem: (): string => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(loadMarkdownMode(throwing, 'md')).toBe('preview');
    expect(() => saveMarkdownMode(throwing, 'md', 'source')).not.toThrow();
    expect(loadSplitFraction(throwing)).toBe(0.5);
    expect(loadMarkdownMode(null, 'md')).toBe('preview');
  });

  it('clamps the split fraction', () => {
    expect(clampFraction(0.05)).toBe(0.2);
    expect(clampFraction(0.95)).toBe(0.8);
    expect(clampFraction(Number.NaN)).toBe(0.5);
  });
});
