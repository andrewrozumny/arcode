import type { ReactElement } from 'react';

type IconKind =
  | 'folder'
  | 'folderOpen'
  | 'ts'
  | 'js'
  | 'json'
  | 'markdown'
  | 'style'
  | 'html'
  | 'image'
  | 'shell'
  | 'config'
  | 'lock'
  | 'file';

const COLORS: Record<IconKind, string> = {
  folder: '#8f9aa8',
  folderOpen: '#8f9aa8',
  ts: '#3b82c4',
  js: '#d4b13a',
  json: '#c58b3a',
  markdown: '#6a9bd1',
  style: '#a572d1',
  html: '#d9733a',
  image: '#3fa89b',
  shell: '#62b543',
  config: '#8a8f98',
  lock: '#6f737a',
  file: '#8a8f98',
};

const BY_EXT: Record<string, IconKind> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'style',
  scss: 'style',
  sass: 'style',
  less: 'style',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image',
  avif: 'image',
  sh: 'shell',
  zsh: 'shell',
  bash: 'shell',
  yml: 'config',
  yaml: 'config',
  toml: 'config',
  ini: 'config',
  env: 'config',
  lock: 'lock',
};

export function iconKindFor(name: string): IconKind {
  const lower = name.toLowerCase();
  if (lower === 'pnpm-lock.yaml' || lower === 'package-lock.json' || lower === 'yarn.lock') return 'lock';
  if (lower.startsWith('.env')) return 'config';
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'file';
  return BY_EXT[lower.slice(dot + 1)] ?? 'file';
}

export function EntryIcon({ name, dir, open }: { name: string; dir: boolean; open: boolean }): ReactElement {
  const kind: IconKind = dir ? (open ? 'folderOpen' : 'folder') : iconKindFor(name);
  const color = COLORS[kind];
  return (
    <svg className="ft-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {kind === 'folder' && <path d="M1 3.2c0-.4.3-.7.7-.7h3.2l1.3 1.5h6.1c.4 0 .7.3.7.7v6.6c0 .4-.3.7-.7.7H1.7a.7.7 0 0 1-.7-.7z" fill={color} />}
      {kind === 'folderOpen' && (
        <>
          <path d="M1 3.2c0-.4.3-.7.7-.7h3.2l1.3 1.5h5.4c.4 0 .7.3.7.7v1H3.4L1 11.5z" fill={color} opacity="0.7" />
          <path d="M3.4 6h10.2l-2.4 5.6a.7.7 0 0 1-.6.4H1.7z" fill={color} />
        </>
      )}
      {kind !== 'folder' && kind !== 'folderOpen' && (
        <>
          <path d="M3 1h5.6L12 4.4V12.3a.7.7 0 0 1-.7.7H3.7a.7.7 0 0 1-.7-.7z" fill="none" stroke={color} strokeWidth="1.1" />
          <path d="M8.4 1v3.6H12" fill="none" stroke={color} strokeWidth="1.1" />
          {kind !== 'file' && <rect x="4.6" y="7.6" width="4.8" height="2.6" rx="0.6" fill={color} />}
        </>
      )}
    </svg>
  );
}

export function Chevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg className={open ? 'ft-chevron open' : 'ft-chevron'} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
