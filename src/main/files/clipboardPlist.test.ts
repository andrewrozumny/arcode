import { describe, expect, it } from 'vitest';
import { fileUrlToPath, filenamesPlist, parseFilenamesPlist, usablePaths } from './clipboardPlist';

describe('filenamesPlist', () => {
  it('round-trips paths with spaces, quotes and XML characters through the reader', () => {
    const paths = ['/Users/me/My Files/a "quoted" <file> & more.txt', '/tmp/plain.md'];
    expect(parseFilenamesPlist(filenamesPlist(paths))).toEqual(paths);
  });
});

describe('usablePaths', () => {
  it('keeps only absolute non-empty strings', () => {
    expect(usablePaths(['/a/b', 'relative', '', 42, null])).toEqual(['/a/b']);
    expect(usablePaths('nope')).toEqual([]);
  });
});

describe('parseFilenamesPlist', () => {
  it('reads every absolute path and decodes entities', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<string>/Users/me/Downloads/a &amp; b.png</string>
	<string>/Users/me/Desktop/Screenshot 2026-10-09 at 11.27.34.png</string>
	<string>relative.txt</string>
</array>
</plist>`;
    expect(parseFilenamesPlist(xml)).toEqual([
      '/Users/me/Downloads/a & b.png',
      '/Users/me/Desktop/Screenshot 2026-10-09 at 11.27.34.png',
    ]);
  });

  it('returns [] for text that is not a plist', () => {
    expect(parseFilenamesPlist('hello')).toEqual([]);
    expect(parseFilenamesPlist('')).toEqual([]);
  });
});

describe('fileUrlToPath', () => {
  it('decodes file URLs and rejects other input', () => {
    expect(fileUrlToPath('file:///Users/me/a%20b.png\n')).toBe('/Users/me/a b.png');
    expect(fileUrlToPath('https://example.com/a')).toBeNull();
    expect(fileUrlToPath('')).toBeNull();
  });
});

describe('parseFilenamesPlist entities', () => {
  it('decodes decimal and hexadecimal character references', () => {
    const xml = '<array><string>/Users/me/caf&#xE9; &#x1F600;.png</string><string>/Users/me/a&#38;b.txt</string></array>';
    expect(parseFilenamesPlist(xml)).toEqual(['/Users/me/café 😀.png', '/Users/me/a&b.txt']);
  });

  it('leaves out-of-range references as they are and does not double-decode &amp;', () => {
    const xml = '<array><string>/x/&#x110000;&amp;#x41;.txt</string></array>';
    expect(parseFilenamesPlist(xml)).toEqual(['/x/&#x110000;&#x41;.txt']);
  });
});
