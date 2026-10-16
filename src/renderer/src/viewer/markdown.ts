import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { dirname, normalizeRel } from './paths';

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Resolves a link or image reference found in `docPath` to a project-relative path.
 * Returns null for external URLs, pure anchors and anything leaving the project root.
 * A leading slash means "relative to the project root".
 */
export function resolveRelativeLink(docPath: string, href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || EXTERNAL.test(trimmed)) return null;
  const clean = trimmed.split('#')[0]?.split('?')[0] ?? '';
  if (!clean) return null;
  let decoded = clean;
  try {
    decoded = decodeURI(clean);
  } catch {
    // keep the raw value
  }
  const joined = decoded.startsWith('/') ? decoded : `${dirname(docPath)}/${decoded}`;
  const normalized = normalizeRel(joined);
  return normalized === null || normalized === '' ? null : normalized;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * DOMPurify settings for rendered Markdown. The default config keeps <style>, style attributes and
 * form controls; the CSP allows inline styles, so a bare <style> in a transcript or a cloned
 * README would restyle the whole window. Like GitHub, styles and forms are dropped. <input> stays
 * for GFM task lists only: `keepTaskCheckboxes` removes every other input.
 */
export const MARKDOWN_SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
};

interface InputLike {
  type: string;
  disabled: boolean;
  remove(): void;
}

/** Keeps the disabled checkboxes of task lists; any other input is removed. */
export function keepTaskCheckboxes(root: { querySelectorAll(selector: 'input'): Iterable<InputLike> }): void {
  for (const input of [...root.querySelectorAll('input')]) {
    if (input.type === 'checkbox') input.disabled = true;
    else input.remove();
  }
}

/** Renders GFM markdown to sanitized HTML (the feed and the file preview alike). */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { gfm: true, async: false });
  const fragment = DOMPurify.sanitize(html, { ...MARKDOWN_SANITIZE, RETURN_DOM_FRAGMENT: true });
  keepTaskCheckboxes(fragment);
  const host = document.createElement('div');
  host.append(fragment);
  return host.innerHTML;
}
