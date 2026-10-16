import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { integer, projectRoot, text, textList, textOrNull } from './ipcArgs';

describe('IPC argument checks', () => {
  it('accepts an absolute existing folder as project root and rejects the rest', async () => {
    await expect(projectRoot(os.tmpdir())).resolves.toBe(os.tmpdir());
    await expect(projectRoot('relative/path')).rejects.toThrow('Not a project folder');
    await expect(projectRoot('/definitely/not/here/acode')).rejects.toThrow('Not a project folder');
    await expect(projectRoot(42)).rejects.toThrow('Invalid project root');
  });

  it('checks primitive arguments', () => {
    expect(text('a', 'name')).toBe('a');
    expect(() => text(1, 'name')).toThrow('Invalid name');
    expect(textOrNull(undefined, 'path')).toBeNull();
    expect(() => textOrNull(5, 'path')).toThrow('Invalid path');
    expect(integer(3, 'id')).toBe(3);
    expect(() => integer(1.5, 'id')).toThrow('Invalid id');
    expect(textList(['a'], 'paths')).toEqual(['a']);
    expect(() => textList(['a', 1], 'paths')).toThrow('Invalid paths');
  });
});
