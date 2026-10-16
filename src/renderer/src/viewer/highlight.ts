import { classHighlighter, highlightCode } from '@lezer/highlight';
import { languageForFence } from './languages';

/**
 * Highlights fenced code blocks (`pre > code.language-x`) of rendered Markdown in place with
 * CodeMirror's parsers and `tok-*` classes, loading each language lazily. Used by the Markdown
 * preview and the Claude feed.
 */
export async function highlightBlocks(container: HTMLElement, isCancelled: () => boolean): Promise<void> {
  for (const code of container.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const info = /language-(\S+)/.exec(code.className)?.[1];
    const description = info ? languageForFence(info) : null;
    if (!description) continue;
    let support;
    try {
      support = await description.load();
    } catch {
      continue;
    }
    if (isCancelled()) return;
    const text = code.textContent ?? '';
    const fragment = document.createDocumentFragment();
    const put = (chunk: string, classes: string): void => {
      if (!classes) fragment.append(chunk);
      else {
        const span = document.createElement('span');
        span.className = classes;
        span.textContent = chunk;
        fragment.append(span);
      }
    };
    highlightCode(text, support.language.parser.parse(text), classHighlighter, put, () =>
      fragment.append('\n'),
    );
    code.replaceChildren(fragment);
  }
}
