import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@shared/app';
import { MAX_RECENT, StateStore, defaultState, migrateState, readStateFile, writeStateFile } from './state';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acode-state-'));
  file = join(dir, 'state.json');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readStateFile', () => {
  it('returns defaults for a missing, empty, blank or corrupt file', () => {
    expect(readStateFile(file)).toEqual(defaultState());
    writeFileSync(file, '');
    expect(readStateFile(file)).toEqual(defaultState());
    writeFileSync(file, '  \n');
    expect(readStateFile(file)).toEqual(defaultState());
    writeFileSync(file, '{"recent": [');
    expect(readStateFile(file)).toEqual(defaultState());
    writeFileSync(file, '[]');
    expect(readStateFile(file)).toEqual(defaultState());
  });

  it('round-trips through writeStateFile atomically', () => {
    const state = defaultState();
    state.recent.push({ root: '/p', openedAt: 5 });
    state.openWindows.push('/p');
    state.projects['/p'] = { bounds: { x: 1, y: 2, width: 900, height: 600 }, layout: { ...DEFAULT_LAYOUT } };
    state.settings.projectRegistryDb = '~/db.sqlite';
    writeStateFile(file, state);
    expect(readStateFile(file)).toEqual(state);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });
});

describe('migrateState', () => {
  it('drops invalid entries and fills missing fields', () => {
    const state = migrateState({
      recent: ['/legacy', { root: '/ok', openedAt: 3 }, { root: 7 }, null],
      openWindows: ['/ok', '/ok', 3, ''],
      projects: {
        '/ok': { bounds: { x: 0, y: 0, width: -1, height: 10 }, layout: { treeWidth: 2, treeVisible: false } },
        '/bad': 'nope',
      },
      settings: { projectRegistryDb: 42 },
    });
    expect(state.version).toBe(1);
    expect(state.recent).toEqual([
      { root: '/legacy', openedAt: 0 },
      { root: '/ok', openedAt: 3 },
    ]);
    expect(state.openWindows).toEqual(['/ok']);
    expect(state.projects['/ok']).toEqual({
      layout: { treeWidth: 0.95, terminalHeight: DEFAULT_LAYOUT.terminalHeight, treeVisible: false, terminalVisible: true },
    });
    expect(state.projects['/bad']).toBeUndefined();
    expect(state.settings).toEqual({});
  });
});

describe('StateStore', () => {
  it('keeps recent projects unique, newest first, capped', () => {
    const store = new StateStore(file, 0);
    for (let i = 0; i < MAX_RECENT + 5; i++) store.addRecent(`/p${i}`, i);
    store.addRecent('/p3', 999);
    const recent = store.get().recent;
    expect(recent).toHaveLength(MAX_RECENT);
    expect(recent[0]).toEqual({ root: '/p3', openedAt: 999 });
    expect(recent.filter((r) => r.root === '/p3')).toHaveLength(1);
  });

  it('debounces writes and flushes on demand', () => {
    vi.useFakeTimers();
    const store = new StateStore(file, 300);
    store.setLayout('/p', { ...DEFAULT_LAYOUT, treeWidth: 0.4 });
    expect(readStateFile(file)).toEqual(defaultState());
    vi.advanceTimersByTime(300);
    expect(readStateFile(file).projects['/p']?.layout?.treeWidth).toBe(0.4);

    store.setOpenWindows(['/a', '/b', '/a']);
    store.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).openWindows).toEqual(['/a', '/b']);
  });

  it('returns the default layout for unknown projects and ignores junk layouts', () => {
    const store = new StateStore(file, 0);
    expect(store.layout('/new')).toEqual(DEFAULT_LAYOUT);
    store.setLayout('/new', 'junk');
    expect(store.project('/new')).toEqual({});
  });
});

describe('terminal tabs', () => {
  const claude = { id: 'tab-1', kind: 'claude', title: 'Claude', claude: { sessionId: 'abc-123', name: 'Claude' } };

  it('keeps valid shell and Claude tabs and drops anything else', () => {
    const state = migrateState({
      projects: {
        '/p': {
          terminal: {
            tabs: [
              claude,
              { id: 'tab-2', kind: 'shell', title: 'Shell' },
              { id: 'tab-3', kind: 'gate', title: 'Gate: lint' },
              { id: 'bad id!', kind: 'shell', title: 'x' },
              { id: 'tab-4', kind: 'claude', title: 'No session' },
            ],
            activeTabId: 'tab-3',
            composerOpen: true,
          },
        },
      },
    });
    expect(state.projects['/p']?.terminal).toEqual({
      tabs: [claude, { id: 'tab-2', kind: 'shell', title: 'Shell' }],
      activeTabId: null,
      composerOpen: true,
    });
  });

  it('stores and returns the tabs of a project', () => {
    const store = new StateStore(file, 0);
    store.setTerminal('/p', { tabs: [claude], activeTabId: 'tab-1', composerOpen: false });
    store.setTerminal('/p', 'garbage');
    expect(store.terminal('/p')).toEqual({ tabs: [claude], activeTabId: 'tab-1', composerOpen: false });
    expect(store.terminal('/other')).toBeUndefined();
  });
});
