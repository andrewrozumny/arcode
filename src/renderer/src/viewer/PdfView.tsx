interface Props {
  /** `arcode-pdf:` URL from the main process; it changes when the file changes on disk. */
  url: string;
  path: string;
}

/**
 * Read-only PDF tab. Chromium's built-in PDF viewer renders the document inside the frame and
 * brings paging, zoom, fit, rotation, search and scrolling. A new URL (the file changed on disk)
 * reloads the frame.
 */
export function PdfView({ url, path }: Props) {
  return <iframe key={url} className="v-pdf" src={url} title={path} />;
}
