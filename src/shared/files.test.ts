import { describe, expect, it } from 'vitest';
import { decodeDraggedPaths, encodeDraggedPaths } from './files';

describe('dragged paths', () => {
  it('round-trips paths, including a file name with a newline', () => {
    const paths = ['/p/a.ts', '/p/odd\nname.txt', '/p/dir'];
    expect(decodeDraggedPaths(encodeDraggedPaths(paths))).toEqual(paths);
  });

  it('treats a value that is not a JSON array of strings as one path', () => {
    expect(decodeDraggedPaths('/p/a.ts')).toEqual(['/p/a.ts']);
    expect(decodeDraggedPaths('{"a":1}')).toEqual(['{"a":1}']);
    expect(decodeDraggedPaths('[1,2]')).toEqual(['[1,2]']);
  });

  it('skips empty entries and empty values', () => {
    expect(decodeDraggedPaths('')).toEqual([]);
    expect(decodeDraggedPaths('["", "/p/a"]')).toEqual(['/p/a']);
  });
});
