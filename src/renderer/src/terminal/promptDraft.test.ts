import { describe, expect, it } from 'vitest';
import { promptDraft } from './promptDraft';
import type { ScreenRow } from './promptDraft';

/** A row from text; characters inside [[...]] are dim. */
function row(spec: string): ScreenRow {
  const chars: string[] = [];
  const dim: boolean[] = [];
  let dimmed = false;
  for (let i = 0; i < spec.length; i++) {
    if (spec.startsWith('[[', i)) {
      dimmed = true;
      i += 1;
      continue;
    }
    if (spec.startsWith(']]', i)) {
      dimmed = false;
      i += 1;
      continue;
    }
    chars.push(spec[i] ?? '');
    dim.push(dimmed);
  }
  return { chars, dim };
}

const RULE = '────────────────────────────────';

describe('promptDraft', () => {
  it('is empty for the dim suggestion of an empty prompt', () => {
    expect(promptDraft([row('● Done.'), row(RULE), row('❯ [[Try "create a util"]]'), row(RULE), row('  ? for shortcuts')])).toBe('');
  });

  it('reads what the user typed, over several rows', () => {
    expect(promptDraft([row(RULE), row('❯ черновик пользователя'), row('  вторая строка'), row(RULE)])).toBe('черновик пользователя\n  вторая строка');
  });

  it('reads the boxed prompt of older versions', () => {
    expect(promptDraft([row('│ > fix the tests    │')])).toBe('fix the tests');
  });

  it('is empty when there is no prompt on screen', () => {
    expect(promptDraft([row('$ ls'), row('README.md')])).toBe('');
  });
});
