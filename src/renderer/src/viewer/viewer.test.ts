import { describe, expect, it } from 'vitest';
import { languageForFence, languageNameForPath } from './languages';
import { MARKDOWN_SANITIZE, keepTaskCheckboxes, resolveRelativeLink, slugify } from './markdown';
import { gitKind, toRelative } from './paths';

describe('languageNameForPath', () => {
  it.each([
    ['src/app.ts', 'TypeScript'],
    ['a/b/index.php', 'PHP'],
    ['package.json', 'JSON'],
    ['style.css', 'CSS'],
    ['README.md', 'Markdown'],
    ['main.py', 'Python'],
  ])('%s -> %s', (path, name) => {
    expect(languageNameForPath(path)).toBe(name);
  });
  it('maps tsx and shell scripts to something', () => {
    expect(languageNameForPath('src/App.tsx')).not.toBeNull();
    expect(languageNameForPath('run.sh')).not.toBeNull();
  });
  it('returns null for unknown extensions', () => {
    expect(languageNameForPath('data.unknownext')).toBeNull();
  });
  it('matches fence info strings', () => {
    expect(languageForFence('ts')?.name).toBe('TypeScript');
    expect(languageForFence('php {1}')?.name).toBe('PHP');
    expect(languageForFence('')).toBeNull();
  });
});

describe('resolveRelativeLink', () => {
  it('resolves relative to the document folder', () => {
    expect(resolveRelativeLink('docs/guide.md', 'img/a.png')).toBe('docs/img/a.png');
    expect(resolveRelativeLink('docs/guide.md', './img/a.png')).toBe('docs/img/a.png');
    expect(resolveRelativeLink('docs/guide.md', '../design/x.svg')).toBe('design/x.svg');
    expect(resolveRelativeLink('README.md', 'design/icon.svg')).toBe('design/icon.svg');
  });
  it('treats a leading slash as project root', () => {
    expect(resolveRelativeLink('docs/guide.md', '/design/x.svg')).toBe('design/x.svg');
  });
  it('strips query and hash and decodes', () => {
    expect(resolveRelativeLink('a.md', 'my%20file.md#top')).toBe('my file.md');
  });
  it('ignores external urls and anchors', () => {
    expect(resolveRelativeLink('a.md', 'https://example.com/x.png')).toBeNull();
    expect(resolveRelativeLink('a.md', '//cdn.example.com/x.png')).toBeNull();
    expect(resolveRelativeLink('a.md', 'mailto:a@b.c')).toBeNull();
    expect(resolveRelativeLink('a.md', '#section')).toBeNull();
  });
  it('refuses to leave the project root', () => {
    expect(resolveRelativeLink('a.md', '../outside.png')).toBeNull();
    expect(resolveRelativeLink('docs/a.md', '../../outside.png')).toBeNull();
  });
});

describe('helpers', () => {
  it('slugifies headings', () => {
    expect(slugify('Hello, World 2')).toBe('hello-world-2');
  });
  it('converts absolute paths inside the root', () => {
    expect(toRelative('/p/root', '/p/root/src/a.ts')).toBe('src/a.ts');
    expect(toRelative('/p/root', '/p/rootx/a.ts')).toBeNull();
    expect(toRelative('/p/root', './src/../a.ts')).toBe('a.ts');
    expect(toRelative('/p/root', '../a.ts')).toBeNull();
  });
  it('maps git statuses', () => {
    expect(gitKind('M')).toBe('modified');
    expect(gitKind(' M')).toBe('modified');
    expect(gitKind('??')).toBe('untracked');
    expect(gitKind('A')).toBe('added');
    expect(gitKind('deleted')).toBe('deleted');
    expect(gitKind(undefined)).toBeNull();
  });
});

describe('markdown sanitizing', () => {
  it('drops styles and form controls', () => {
    for (const tag of ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed']) {
      expect(MARKDOWN_SANITIZE.FORBID_TAGS).toContain(tag);
    }
    expect(MARKDOWN_SANITIZE.FORBID_ATTR).toContain('style');
  });

  it('keeps task list checkboxes, disabled, and removes any other input', () => {
    const removed: string[] = [];
    const input = (type: string, disabled: boolean) => ({
      type,
      disabled,
      remove: () => removed.push(type),
    });
    const inputs = [input('checkbox', true), input('checkbox', false), input('text', false), input('password', false)];
    keepTaskCheckboxes({ querySelectorAll: () => inputs });
    expect(removed).toEqual(['text', 'password']);
    expect(inputs[0]?.disabled).toBe(true);
    expect(inputs[1]?.disabled).toBe(true);
  });
});
