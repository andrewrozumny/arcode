import { describe, expect, it } from 'vitest';
import type { FeedQuestion } from '@shared/claude';
import { ENTER, RIGHT, cleanAnswerText, parseScreenPrompt, questionKeys, screenShows, sendKeys } from './feedKeys';

const q = (question: string, labels: string[], multiSelect = false): FeedQuestion => ({
  question,
  header: null,
  multiSelect,
  options: labels.map((label) => ({ label, description: null })),
});

const size = q('Pick a size', ['Small', 'Medium', 'Large']);
const color = q('Pick a color', ['Red', 'Green', 'Blue']);
const sides = q('Pick sides', ['Fries', 'Salad', 'Soup'], true);

describe('questionKeys', () => {
  it('answers a lone single-select question with its number alone', () => {
    expect(questionKeys([size], [{ kind: 'options', picks: [2] }])).toEqual(['3']);
  });

  it('answers several single-select questions and submits on the review tab', () => {
    expect(questionKeys([color, size], [{ kind: 'options', picks: [1] }, { kind: 'options', picks: [0] }])).toEqual(['2', '1', '1']);
  });

  it('toggles multi-select options, moves on with Right and submits', () => {
    expect(questionKeys([sides], [{ kind: 'options', picks: [2, 0, 2] }])).toEqual(['1', '3', RIGHT, '1']);
    expect(questionKeys([color, sides], [{ kind: 'options', picks: [0] }, { kind: 'options', picks: [1] }])).toEqual(['1', '2', RIGHT, '1']);
  });

  it('types an own answer after the "Type something" number', () => {
    expect(questionKeys([color, sides], [{ kind: 'other', text: ' Purple\nplease ' }, { kind: 'options', picks: [0] }])).toEqual([
      '4',
      'Purple please',
      ENTER,
      '1',
      RIGHT,
      '1',
    ]);
  });

  it('refuses what it cannot type reliably', () => {
    expect(questionKeys([sides], [{ kind: 'other', text: 'Bread' }])).toBeNull();
    expect(questionKeys([color, size], [{ kind: 'options', picks: [0] }, undefined])).toBeNull();
    expect(questionKeys([color], [{ kind: 'options', picks: [0, 1] }])).toBeNull();
    expect(questionKeys([color], [{ kind: 'options', picks: [3] }])).toBeNull();
    expect(questionKeys([color], [{ kind: 'other', text: '\u001b\r' }])).toBeNull();
    expect(questionKeys([q('Too many', ['1', '2', '3', '4', '5', '6', '7', '8', '9'])], [{ kind: 'options', picks: [0] }])).toBeNull();
    expect(questionKeys([], [])).toBeNull();
  });

  it('cleans typed text to one line without control characters', () => {
    expect(cleanAnswerText('a\tb\r\nc\u001b[A')).toBe('a b c [A');
  });
});

// Screens as Claude Code 2.1 draws them (100 columns), with neutral content.
const PLAN_SCREEN = [
  '⏺ Here is the plan.',
  '   1. Create notes.txt in the working directory.',
  '   2. Write a line into it.',
  '─'.repeat(100),
  ' Ready to code?',
  '',
  ' Here is Claude\'s plan:',
  '╌'.repeat(100),
  ' Plan: create notes.txt',
  '',
  ' 1. Create notes.txt.',
  ' 2. Verify it.',
  '╌'.repeat(100),
  '',
  '─'.repeat(100),
  ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
  '',
  ' ❯ 1. Yes, and use auto mode',
  '   2. Yes, manually approve edits',
  '   3. Tell Claude what to change',
  '      shift+tab to approve with this feedback',
  '',
  ' ctrl+g to edit in Vim · ~/.claude/plans/some-plan.md',
];

const PERMISSION_SCREEN = [
  '⏺ Write(notes.txt)',
  '─'.repeat(100),
  ' Create file',
  ' notes.txt',
  '╌'.repeat(100),
  '  1 hello',
  '╌'.repeat(100),
  ' Do you want to create notes.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this',
  '      session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
];

const QUESTION_SCREEN = [
  '─'.repeat(100),
  '←  ☐ Color  ☐ Size  ✔ Submit  →',
  '',
  'Pick a color',
  '',
  '❯ 1. Red',
  '     Warm red',
  '  2. Green',
  '  3. Blue',
  '  4. Type something.',
  '─'.repeat(100),
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

const IDLE_SCREEN = ['⏺ Done:', '  1. Fixed the bug', '  2. Added a test', '─'.repeat(100), '❯ 1. typed by the user', '─'.repeat(100), '  ? for shortcuts'];

describe('parseScreenPrompt', () => {
  it('reads the plan approval options, not the numbered steps of the plan', () => {
    expect(parseScreenPrompt(PLAN_SCREEN, 100)).toEqual({
      title: 'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      options: [
        { key: '1', label: 'Yes, and use auto mode', selected: true, needsText: false },
        { key: '2', label: 'Yes, manually approve edits', selected: false, needsText: false },
        { key: '3', label: 'Tell Claude what to change', selected: false, needsText: true },
      ],
    });
  });

  it('reads a permission prompt and joins a wrapped label', () => {
    const prompt = parseScreenPrompt(PERMISSION_SCREEN, 100);
    expect(prompt?.title).toBe('Do you want to create notes.txt?');
    expect(prompt?.options.map((o) => [o.key, o.label])).toEqual([
      ['1', 'Yes'],
      ['2', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)'],
      ['3', 'No'],
    ]);
  });

  it('finds no prompt when only Claude output or the input box is numbered', () => {
    expect(parseScreenPrompt(IDLE_SCREEN, 100)).toBeNull();
    // The question UI ends with its own separator; its options are answered from the transcript instead.
    expect(parseScreenPrompt(QUESTION_SCREEN, 100)).toBeNull();
    expect(parseScreenPrompt([], 100)).toBeNull();
  });

  it('tells whether the screen shows a question', () => {
    expect(screenShows(QUESTION_SCREEN, 'Pick a color')).toBe(true);
    expect(screenShows(QUESTION_SCREEN, 'Pick a size')).toBe(false);
    expect(screenShows(QUESTION_SCREEN, '')).toBe(false);
  });
});

describe('sendKeys', () => {
  it('writes each step on its own with a pause in between', async () => {
    const log: string[] = [];
    await sendKeys((data) => log.push(data), ['1', RIGHT, '1'], 150, (ms) => {
      log.push(`wait ${ms}`);
      return Promise.resolve();
    });
    expect(log).toEqual(['1', 'wait 150', RIGHT, 'wait 150', '1']);
  });
});
