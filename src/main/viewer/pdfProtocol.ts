/**
 * The `arcode-pdf:` protocol: serves PDFs of open projects to the viewer's iframe, where
 * Chromium's built-in PDF viewer renders them. What may be read is decided in `pdf.ts`.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { PDF_MIME, PDF_SCHEME, resolvePdfRequest } from './pdf';

/** Must run before `app.whenReady()`: privileges can only be set before the app is ready. */
export function registerPdfScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PDF_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/** Starts serving PDFs inside the roots `openRoots` returns at request time. */
export function handlePdfProtocol(openRoots: () => readonly string[]): void {
  protocol.handle(PDF_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const target = await resolvePdfRequest(request.url, openRoots());
    if (!target.ok) return new Response(target.message, { status: target.status });
    const headers = {
      'Content-Type': PDF_MIME,
      'Content-Length': String(target.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    const body = Readable.toWeb(createReadStream(target.abs)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  });
}
