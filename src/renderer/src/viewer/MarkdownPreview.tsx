import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { viewerApi } from './api';
import { highlightBlocks } from './highlight';
import { renderMarkdown, resolveRelativeLink, slugify } from './markdown';

interface Props {
  source: string;
  /** Project-relative path of the document, used to resolve relative links and images. */
  path: string;
  root: string;
  onOpenFile: (path: string) => void;
  /**
   * Live preview of the split view: blocks carry `data-line` for scroll sync and loaded images are
   * reused between renders, so typing does not make them flicker.
   */
  live?: boolean;
  /** Called after each render has been put into the page. */
  onRendered?: () => void;
}

/** Sanitized HTML with relative image sources parked in data-src (nothing is fetched from the app origin). */
function prepare(source: string, docPath: string, sourceLines: boolean): string {
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(source, { sourceLines });
  for (const img of template.content.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (resolveRelativeLink(docPath, src) !== null) {
      img.setAttribute('data-src', src);
      img.removeAttribute('src');
    }
  }
  for (const heading of template.content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    heading.id = slugify(heading.textContent ?? '');
  }
  return template.innerHTML;
}

/** The forwarded ref is the scroll container. */
export const MarkdownPreview = forwardRef<HTMLDivElement, Props>(function MarkdownPreview(
  { source, path, root, onOpenFile, live = false, onRendered },
  scrollRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => prepare(source, path, live), [source, path, live]);
  const imageCache = useRef(new Map<string, string>());
  const onRenderedRef = useRef(onRendered);

  useEffect(() => {
    onRenderedRef.current = onRendered;
  });

  // A different document or leaving live mode starts with fresh images.
  useEffect(() => {
    imageCache.current.clear();
  }, [path, root, live]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = html;
    let cancelled = false;
    const api = viewerApi();
    const cache = imageCache.current;

    for (const img of host.querySelectorAll<HTMLImageElement>('img[data-src]')) {
      const rel = resolveRelativeLink(path, img.dataset.src ?? '');
      if (!rel) continue;
      const cached = live ? cache.get(rel) : undefined;
      if (cached) {
        img.src = cached;
        continue;
      }
      void api.readFile(root, rel).then((result) => {
        if (cancelled) return;
        if (result.kind === 'image') {
          img.src = result.dataUrl;
          if (live) cache.set(rel, result.dataUrl);
        } else {
          img.classList.add('broken');
          img.alt = img.alt || `Cannot load ${rel}`;
        }
      });
    }
    void highlightBlocks(host, () => cancelled);
    onRenderedRef.current?.();
    return () => {
      cancelled = true;
    };
  }, [html, path, root, live]);

  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    event.preventDefault();
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      hostRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const rel = resolveRelativeLink(path, href);
    if (rel) onOpenFile(rel);
    else if (/^https?:/i.test(href)) window.open(href);
  };

  return (
    <div ref={scrollRef} className="v-md-scroll">
      {/* Content is sanitized by DOMPurify before insertion in the layout effect. */}
      <div ref={hostRef} className="v-md" onClick={onClick} />
    </div>
  );
});
