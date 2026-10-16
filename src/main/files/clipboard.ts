/**
 * Files on the macOS clipboard. Reading accepts what Finder copies (the NSFilenamesPboardType
 * plist, with `text/uri-list` as the portable fallback). Writing puts files on the clipboard the way
 * Finder does: the plist (so Finder and other apps paste the files themselves) plus the absolute
 * paths as plain text (so text fields get something useful). Verified: Electron 44 writes both
 * flavors in one item.
 */
import { clipboard, ClipboardItem } from 'electron';
import { FILENAMES_FLAVOR, fileUrlToPath, filenamesPlist, parseFilenamesPlist, usablePaths } from './clipboardPlist';

async function blobText(value: unknown): Promise<string> {
  const blob = value as { text?: () => Promise<string> } | null;
  return blob && typeof blob.text === 'function' ? blob.text() : '';
}

/** Absolute paths of the files currently on the clipboard; [] when it holds none. */
export async function readClipboardFiles(): Promise<string[]> {
  let items: Electron.ClipboardItem[];
  try {
    items = await clipboard.read();
  } catch {
    return [];
  }
  for (const item of items) {
    if (item.types.includes(FILENAMES_FLAVOR)) {
      const paths = parseFilenamesPlist(await blobText(await item.getType(FILENAMES_FLAVOR).catch(() => null)));
      if (paths.length > 0) return paths;
    }
    if (item.types.includes('text/uri-list')) {
      const text = await blobText(await item.getType('text/uri-list').catch(() => null));
      const paths = text
        .split(/\r?\n/)
        .map((line) => fileUrlToPath(line))
        .filter((path): path is string => path !== null);
      if (paths.length > 0) return paths;
    }
  }
  return [];
}

export async function writeFilesToClipboard(paths: unknown): Promise<void> {
  const list = usablePaths(paths);
  if (list.length === 0) return;
  await clipboard.write([
    new ClipboardItem({
      [FILENAMES_FLAVOR]: new Blob([filenamesPlist(list)], { type: FILENAMES_FLAVOR }),
      'text/plain': list.join('\n'),
    }),
  ]);
}
