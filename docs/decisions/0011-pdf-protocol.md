# 0011. PDFs through a guarded custom protocol

## Context

Claude sessions often produce PDFs (plans, reports, invoices) that the user wants to check
without leaving the project window. PDFs used to show the binary placeholder. Windows are
sandboxed, use context isolation and a strict Content Security Policy, and load the renderer from
`file://`, so the page cannot point a frame at an arbitrary local file. Rendering with pdf.js
would add a large dependency and a worker, and would mean rebuilding paging, zoom and search.

## Decision

Project windows enable `webPreferences.plugins`, so Chromium's built-in PDF viewer renders PDFs.
The viewer tab is an iframe on the privileged `arcode-pdf:` scheme (standard, secure, fetch API,
streaming), registered before `ready`. Its handler (`viewer/pdfProtocol.ts`, logic in
`viewer/pdf.ts`) serves a request only when:

- the `root` query parameter is the root of an open project window,
- the path passes `files/paths.ts` (`resolveInside`: no `..`, no absolute path, no symlink out),
- the name ends in `.pdf` and the first kilobyte holds a `%PDF-` header.

Everything else gets 400, 403, 404, 405 or 415. The response is always `application/pdf` with
`nosniff` and `no-store`. The page's CSP adds only `frame-src arcode-pdf:`; `connect-src` is not
widened, so the page cannot fetch from the scheme. Frames inside the page may not navigate to web,
mail or file URLs; those links open in the default browser.

## Consequences

- PDF tabs get paging, zoom, rotation, thumbnails and scrolling with no new dependency.
- Reload after a change on disk is a new URL (the mtime is part of it); the document reopens at
  the first page.
- Keys pressed while the PDF frame has focus go to the PDF viewer, not to the renderer's own
  shortcuts; menu accelerators still work.
- The built-in viewer's toolbar includes download and print. Download saves a copy through Electron's
  default download handling; the project file itself is never written.
