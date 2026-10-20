import { describe, expect, it } from 'vitest';
import { feedMarkdownHtml, prepareFeedMarkdown } from './feedMarkdownText';

const html = (source: string): string => feedMarkdownHtml(source).replace(/\n/g, '');

// Shapes seen in real replies, rewritten with neutral text.
describe('feed Markdown', () => {
  it('renders a numbered list that continues at 7 under a label as a list', () => {
    const out = html('**Still to do:**\n7. Remove the hover glow.\n8. Halve the underline.\n9. Soften the seam under the header.');
    expect(out).toBe('<p><strong>Still to do:</strong></p><ol start="7"><li>Remove the hover glow.</li><li>Halve the underline.</li><li>Soften the seam under the header.</li></ol>');
  });

  it('keeps lists after a line ending with a colon, numbered from 1 or bulleted', () => {
    expect(html('Plan:\n1. Read\n2. Fix')).toBe('<p>Plan:</p><ol><li>Read</li><li>Fix</li></ol>');
    expect(html('Plan:\n- Read\n- Fix')).toBe('<p>Plan:</p><ul><li>Read</li><li>Fix</li></ul>');
  });

  it('turns "•" bullets into list items, also inside quotes', () => {
    expect(html('Summary:\n• One\n• Two')).toBe('<p>Summary:</p><ul><li>One</li><li>Two</li></ul>');
    expect(html('> **Site A**\n> • Tiles are clickable\n> • Wider form')).toBe(
      '<blockquote><p><strong>Site A</strong></p><ul><li>Tiles are clickable</li><li>Wider form</li></ul></blockquote>',
    );
  });

  it('keeps line breaks the way the terminal shows them', () => {
    expect(html('**Now**\nThe agent runs steps 1-2.')).toBe('<p><strong>Now</strong><br>The agent runs steps 1-2.</p>');
    expect(html('First line\nSecond line')).toBe('<p>First line<br>Second line</p>');
  });

  it('nests bullets under numbered items', () => {
    expect(html('1. Build\n   - lint\n   - test\n2. Ship')).toBe('<ol><li>Build<ul><li>lint</li><li>test</li></ul></li><li>Ship</li></ol>');
  });

  it('leaves fenced code alone', () => {
    const source = 'Run:\n```text\nNotes:\n7. not a list\n• not a bullet\n```';
    expect(prepareFeedMarkdown(source)).toBe(source);
    expect(html(source)).toContain('7. not a list\n• not a bullet'.replace(/\n/g, ''));
  });

  it('does not touch numbered lines that already form a list or follow structure', () => {
    const list = '1. One\n2. Two\n3. Three';
    expect(prepareFeedMarkdown(list)).toBe(list);
    const afterHeading = '## Steps\n2. Second';
    expect(prepareFeedMarkdown(afterHeading)).toBe(afterHeading);
    // A wrapped continuation inside a list item is not a paragraph to split.
    const nested = '- Item\n  3. inner';
    expect(prepareFeedMarkdown(nested)).toBe(nested);
  });

  it('renders tables and keeps long inline code as one code span', () => {
    expect(html('Results:\n| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
    const path = '`/very/long/path/that/goes/on/and/on/without/any/spaces/at/all/file.ts`';
    expect(html(path)).toBe(`<p><code>${path.slice(1, -1)}</code></p>`);
  });
});
