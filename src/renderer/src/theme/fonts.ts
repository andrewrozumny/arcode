/**
 * Registers the bundled JetBrains Mono (variable, OFL) under the family name
 * "JetBrains Mono", so `var(--font-mono)` and the terminal use it whether or not
 * the font is installed on the system.
 */
import latin from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import latinExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url';
import cyrillic from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-wght-normal.woff2?url';
import cyrillicExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-ext-wght-normal.woff2?url';
import greek from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-greek-wght-normal.woff2?url';

export const MONO_FAMILY = 'JetBrains Mono';

const FACES: [string, string][] = [
  [
    latin,
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  ],
  [
    latinExt,
    'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  ],
  [cyrillic, 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
  [cyrillicExt, 'U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F'],
  [greek, 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF'],
];

let ready: Promise<void> | undefined;

/** Adds the font faces and waits until regular and bold are usable. Never rejects. */
export function loadFonts(): Promise<void> {
  ready ??= (async () => {
    try {
      // Load every subset explicitly: the terminal draws on a canvas, which never triggers the lazy
      // download of a unicode-range face, so Cyrillic and Greek would silently fall back to Menlo.
      const faces = FACES.map(
        ([url, unicodeRange]) =>
          new FontFace(MONO_FAMILY, `url(${url}) format('woff2')`, { weight: '100 800', style: 'normal', unicodeRange }),
      );
      await Promise.all(
        faces.map(async (face) => {
          await face.load();
          document.fonts.add(face);
        }),
      );
    } catch (error) {
      console.warn('Bundled monospace font failed to load', error);
    }
  })();
  return ready;
}
