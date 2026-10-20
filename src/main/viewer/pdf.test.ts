import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPdfHeader, isPdfPath, markdownSourceFor, parsePdfUrl, pdfUrl, resolvePdfRequest } from './pdf';
import { readFile } from './service';

const PDF = '%PDF-1.4\n%fake\n';

let base: string;
let root: string;
let other: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pdf-')));
  root = join(base, 'project');
  other = join(base, 'elsewhere');
  mkdirSync(join(root, 'out', 'my docs'), { recursive: true });
  mkdirSync(other);
  writeFileSync(join(root, 'out', 'plan.pdf'), PDF);
  writeFileSync(join(root, 'out', 'plan.md'), '# Plan');
  writeFileSync(join(root, 'out', 'my docs', 'a#b.PDF'), PDF);
  writeFileSync(join(root, 'out', 'fake.pdf'), 'not a pdf at all');
  writeFileSync(join(root, 'out', 'notes.txt'), PDF);
  mkdirSync(join(root, 'out', 'folder.pdf'));
  writeFileSync(join(other, 'secret.pdf'), PDF);
  symlinkSync(join(other, 'secret.pdf'), join(root, 'out', 'link.pdf'));
  symlinkSync(other, join(root, 'escape'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('pdf urls', () => {
  it('round-trips root and path, including spaces and reserved characters', () => {
    const url = pdfUrl(root, 'out/my docs/a#b.PDF', 1234.6);
    expect(url.startsWith('arcode-pdf://doc/out/my%20docs/a%23b.PDF?')).toBe(true);
    expect(url).toContain('v=1235');
    expect(parsePdfUrl(url)).toEqual({ root, relPath: 'out/my docs/a#b.PDF' });
  });

  it('normalizes the relative path and refuses one that escapes', () => {
    expect(parsePdfUrl(pdfUrl(root, './out//plan.pdf', 1))?.relPath).toBe('out/plan.pdf');
    expect(() => pdfUrl(root, '../x.pdf', 1)).toThrow();
  });

  it('rejects other schemes, hosts and malformed urls', () => {
    expect(parsePdfUrl('file:///etc/passwd')).toBeNull();
    expect(parsePdfUrl(`arcode-pdf://other/out/plan.pdf?root=${encodeURIComponent(root)}`)).toBeNull();
    expect(parsePdfUrl('arcode-pdf://doc/out/plan.pdf')).toBeNull();
    expect(parsePdfUrl(`arcode-pdf://doc/%E0%A4%A?root=${encodeURIComponent(root)}`)).toBeNull();
    expect(parsePdfUrl('not a url')).toBeNull();
  });
});

describe('pdf checks', () => {
  it('matches the extension case-insensitively', () => {
    expect(isPdfPath('a/b.pdf')).toBe(true);
    expect(isPdfPath('a/b.PDF')).toBe(true);
    expect(isPdfPath('a/b.pdf.txt')).toBe(false);
    expect(isPdfPath('pdf')).toBe(false);
  });

  it('finds the header at the start or after a little junk', () => {
    expect(hasPdfHeader(Buffer.from('%PDF-1.7'))).toBe(true);
    expect(hasPdfHeader(Buffer.from('\n\n%PDF-1.7'))).toBe(true);
    expect(hasPdfHeader(Buffer.from('<html>'))).toBe(false);
    expect(hasPdfHeader(Buffer.concat([Buffer.alloc(2000, 32), Buffer.from('%PDF-')]))).toBe(false);
  });
});

describe('resolvePdfRequest', () => {
  const request = (rel: string, r = root): string =>
    `arcode-pdf://doc/${rel}?root=${encodeURIComponent(r)}&v=1`;

  it('serves a PDF inside an open project', async () => {
    expect(await resolvePdfRequest(pdfUrl(root, 'out/plan.pdf', 1), [root])).toEqual({
      ok: true,
      abs: join(root, 'out', 'plan.pdf'),
      size: PDF.length,
    });
    expect(await resolvePdfRequest(pdfUrl(root, 'out/my docs/a#b.PDF', 1), [`${root}/`])).toMatchObject({ ok: true });
  });

  it('refuses a root that is not open', async () => {
    expect(await resolvePdfRequest(pdfUrl(other, 'secret.pdf', 1), [root])).toMatchObject({ ok: false, status: 403 });
    expect(await resolvePdfRequest(request('out/plan.pdf', 'relative/root'), ['relative/root'])).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('refuses traversal, encoded traversal and symlinks out of the root', async () => {
    expect(await resolvePdfRequest(request('%2E%2E/elsewhere/secret.pdf'), [root])).toMatchObject({ ok: false });
    expect(await resolvePdfRequest(request('out%2F..%2F..%2Felsewhere%2Fsecret.pdf'), [root])).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await resolvePdfRequest(request('out/link.pdf'), [root])).toMatchObject({ ok: false, status: 403 });
    expect(await resolvePdfRequest(request('escape/secret.pdf'), [root])).toMatchObject({ ok: false, status: 403 });
  });

  it('serves only PDFs', async () => {
    expect(await resolvePdfRequest(request('out/notes.txt'), [root])).toMatchObject({ ok: false, status: 415 });
    expect(await resolvePdfRequest(request('out/fake.pdf'), [root])).toMatchObject({ ok: false, status: 415 });
    expect(await resolvePdfRequest(request('out/folder.pdf'), [root])).toMatchObject({ ok: false, status: 404 });
    expect(await resolvePdfRequest(request('out/missing.pdf'), [root])).toMatchObject({ ok: false, status: 404 });
    expect(await resolvePdfRequest('https://example.com/a.pdf', [root])).toMatchObject({ ok: false, status: 400 });
  });
});

describe('readFile for PDFs', () => {
  it('returns a viewer url and the Markdown source next to it', async () => {
    const result = await readFile(root, 'out/plan.pdf');
    expect(result).toMatchObject({ kind: 'pdf', size: PDF.length, markdownSource: 'out/plan.md' });
    if (result.kind === 'pdf') expect(parsePdfUrl(result.url)).toEqual({ root, relPath: 'out/plan.pdf' });
  });

  it('has no Markdown source when there is none', async () => {
    expect(await markdownSourceFor(root, 'out/my docs/a#b.PDF')).toBeNull();
    expect(await readFile(root, 'out/my docs/a#b.PDF')).toMatchObject({ kind: 'pdf', markdownSource: null });
  });

  it('keeps the path guard for PDFs', async () => {
    expect(await readFile(root, 'out/link.pdf')).toMatchObject({ kind: 'error' });
  });
});
