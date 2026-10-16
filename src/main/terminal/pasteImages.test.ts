import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASTE_MAX_AGE_MS, prunePastedImages, savePastedImage } from './pasteImages';

describe('pasted images', () => {
  it('saves supported images and refuses anything else', async () => {
    const dir = join(mkdtempSync(join(os.tmpdir(), 'acode-paste-')), 'paste');
    const file = await savePastedImage(dir, new Uint8Array([1, 2, 3]), 'image/png');
    expect(file.startsWith(dir)).toBe(true);
    expect(file.endsWith('.png')).toBe(true);
    await expect(savePastedImage(dir, new Uint8Array([1]), 'text/html')).rejects.toThrow('Unsupported image type');
    await expect(savePastedImage(dir, new Uint8Array(), 'image/png')).rejects.toThrow('Invalid image data');
    await expect(savePastedImage(dir, 'not bytes', 'image/png')).rejects.toThrow('Invalid image data');
  });

  it('prunes files older than a week and keeps newer ones', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'acode-prune-'));
    const now = Date.now();
    const old = join(dir, 'old.png');
    const fresh = join(dir, 'fresh.png');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const oldSeconds = (now - PASTE_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(old, oldSeconds, oldSeconds);
    expect(await prunePastedImages(dir, PASTE_MAX_AGE_MS, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(dir)).toEqual(['fresh.png']);
  });

  it('does nothing when the folder does not exist', async () => {
    expect(await prunePastedImages(join(os.tmpdir(), `acode-missing-${Date.now()}`))).toBe(0);
  });
});
