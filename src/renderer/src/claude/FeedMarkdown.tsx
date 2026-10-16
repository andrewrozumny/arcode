import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';
import { bus } from '../bus';
import { findLinkMatches } from '../terminal/links';
import { terminalApi } from '../terminal/api';
import { highlightBlocks } from '../viewer/highlight';
import { renderMarkdown } from '../viewer/markdown';

/** File references linked per message at most; each needs one existence check in main. */
const MAX_FILE_LINKS = 60;
/** Inline code that is a path, optionally with `:line` or `:line-line`. */
const CODE_PATH = /^((?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]+|(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\/?)(?::(\d+)(?:-(\d+))?)?$/;

/** Existence checks by root and path; positive and negative answers are both kept for the session. */
const resolved = new Map<string, Promise<string | null>>();

function resolveInProject(path: string, root: string): Promise<string | null> {
  const key = `${root}\0${path}`;
  let hit = resolved.get(key);
  if (!hit) {
    if (resolved.size > 2000) resolved.clear();
    const base = root.endsWith('/') ? root : `${root}/`;
    hit = terminalApi()
      .resolveFile(path, root)
      .then((absolute) => (absolute && absolute.startsWith(base) ? absolute : null))
      .catch(() => null);
    resolved.set(key, hit);
  }
  return hit;
}

interface Ref {
  path: string;
  line?: number | undefined;
}

/** A reference inside a text node: `length` characters of path from `start`. */
interface TextRef extends Ref {
  start: number;
  length: number;
}

function fileAnchor(absolute: string, line: number | undefined, children: Node[]): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.className = 'fd-file';
  anchor.href = '#';
  anchor.dataset.file = absolute;
  if (line !== undefined) anchor.dataset.line = String(line);
  anchor.title = line !== undefined ? `${absolute}:${line}` : absolute;
  anchor.append(...children);
  return anchor;
}

/**
 * Turns file references into links once main confirms they exist inside the project: inline code
 * that is a path (`src/a.ts:42`) and bare paths in prose. Code blocks and links are left alone.
 */
async function linkFiles(host: HTMLElement, root: string, isCancelled: () => boolean): Promise<void> {
  const codes: { el: HTMLElement; ref: Ref }[] = [];
  for (const code of host.querySelectorAll<HTMLElement>('code')) {
    if (code.closest('pre, a')) continue;
    const match = CODE_PATH.exec((code.textContent ?? '').trim());
    if (!match?.[1]) continue;
    codes.push({ el: code, ref: { path: match[1], line: match[2] ? Number(match[2]) : undefined } });
  }
  const texts: { node: Text; refs: TextRef[] }[] = [];
  let budget = MAX_FILE_LINKS - codes.length;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('pre, code, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node && budget > 0; node = walker.nextNode()) {
    const text = node as Text;
    const refs: TextRef[] = [];
    for (const match of findLinkMatches(text.data)) {
      const candidate = match.candidates[0];
      if (candidate) refs.push({ path: candidate.path, start: candidate.start, length: candidate.path.length, line: match.line });
    }
    if (refs.length === 0) continue;
    budget -= refs.length;
    texts.push({ node: text, refs });
  }

  const [codeHits, textHits] = await Promise.all([
    Promise.all(codes.slice(0, MAX_FILE_LINKS).map(({ ref }) => resolveInProject(ref.path, root))),
    Promise.all(texts.map(({ refs }) => Promise.all(refs.map((ref) => resolveInProject(ref.path, root))))),
  ]);
  if (isCancelled()) return;

  codes.slice(0, MAX_FILE_LINKS).forEach(({ el, ref }, i) => {
    const absolute = codeHits[i];
    if (absolute && el.isConnected) el.replaceWith(fileAnchor(absolute, ref.line, [el.cloneNode(true)]));
  });
  texts.forEach(({ node, refs }, i) => {
    if (!node.isConnected) return;
    const hits = textHits[i] ?? [];
    const fragment = document.createDocumentFragment();
    let at = 0;
    refs.forEach((ref, j) => {
      const absolute = hits[j];
      if (!absolute || ref.start < at) return;
      fragment.append(node.data.slice(at, ref.start));
      const end = ref.start + ref.length;
      // Keep a `:line` suffix inside the link text.
      const suffix = ref.line !== undefined ? /^:\d+(?:-\d+)?/.exec(node.data.slice(end))?.[0] ?? '' : '';
      fragment.append(fileAnchor(absolute, ref.line, [document.createTextNode(node.data.slice(ref.start, end + suffix.length))]));
      at = end + suffix.length;
    });
    if (at === 0) return;
    fragment.append(node.data.slice(at));
    node.replaceWith(fragment);
  });
}

/** Copies text and shows "Copied" on the button for a moment. */
export function copyWithFeedback(button: HTMLElement, text: string): void {
  void navigator.clipboard?.writeText(text).then(() => {
    const label = button.textContent;
    button.classList.add('copied');
    button.textContent = 'Copied';
    window.setTimeout(() => {
      button.classList.remove('copied');
      button.textContent = label;
    }, 1400);
  });
}

/** Wraps each code block in a frame with its language and a copy button. */
function frameCodeBlocks(host: HTMLElement): void {
  for (const pre of host.querySelectorAll<HTMLElement>(':scope pre')) {
    if (pre.parentElement?.classList.contains('fd-codeblock')) continue;
    const lang = /language-(\S+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ?? '';
    const frame = document.createElement('div');
    frame.className = 'fd-codeblock';
    const head = document.createElement('div');
    head.className = 'fd-codeblock-head';
    const label = document.createElement('span');
    label.textContent = lang;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'fd-copy';
    copy.dataset.copy = '';
    copy.textContent = 'Copy';
    copy.title = 'Copy code';
    head.append(label, copy);
    pre.replaceWith(frame);
    frame.append(head, pre);
  }
}

/** Opens file links in the viewer and web links in the default browser; copies code blocks. */
function onClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;
  const copy = target.closest<HTMLElement>('button[data-copy]');
  if (copy) {
    const code = copy.closest('.fd-codeblock')?.querySelector('pre');
    if (code) copyWithFeedback(copy, code.textContent ?? '');
    return;
  }
  const anchor = target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  const file = anchor.dataset.file;
  if (file) {
    const line = anchor.dataset.line ? Number(anchor.dataset.line) : undefined;
    bus.openFile(line === undefined ? { path: file } : { path: file, line });
    return;
  }
  const href = anchor.getAttribute('href') ?? '';
  if (/^https?:/i.test(href)) window.open(href);
}

/** One Markdown message of the feed: sanitized HTML, highlighted code blocks, clickable links. */
export const FeedMarkdown = memo(function FeedMarkdown({ text, root, className }: { text: string; root: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Sanitized by DOMPurify in renderMarkdown.
    host.innerHTML = html;
    for (const anchor of host.querySelectorAll('a[href]')) anchor.setAttribute('title', anchor.getAttribute('href') ?? '');
    frameCodeBlocks(host);
    let cancelled = false;
    void highlightBlocks(host, () => cancelled);
    void linkFiles(host, root, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [html, root]);

  return <div ref={hostRef} className={className ? `v-md fd-md ${className}` : 'v-md fd-md'} onClick={onClick} />;
});

/**
 * A highlighted code block outside Markdown (a command, a file's new content). The text is set
 * imperatively because highlighting replaces the code element's children.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang, className }: { code: string; lang: string | null; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const el = codeRef.current;
    if (!host || !el) return;
    el.textContent = code;
    if (!lang) return;
    let cancelled = false;
    void highlightBlocks(host, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return (
    <div ref={hostRef} className="fd-code-host">
      <pre className={className ? `fd-pre ${className}` : 'fd-pre'}>
        <code ref={codeRef} className={lang ? `language-${lang}` : undefined} />
      </pre>
    </div>
  );
});
