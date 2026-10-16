import type { ReactNode } from 'react';
import type { ToolIcon } from './feedTools';

/** 16x16 stroke icons of the Claude feed, drawn in the current text colour. */
const PATHS: Record<ToolIcon | 'copy' | 'check' | 'image' | 'spark' | 'clock', ReactNode> = {
  read: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5.25h3.5M6.25 8.25h4M6.25 10.75h4" />
    </>
  ),
  edit: (
    <>
      <path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" />
      <path d="M9 4l3 3" />
    </>
  ),
  write: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M8.25 7.25v5M5.75 9.75h5" />
    </>
  ),
  bash: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M4.5 6.25l2 1.75-2 1.75M8 10.25h3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25l3.5 3.5" />
    </>
  ),
  agent: (
    <>
      <rect x="3" y="4.5" width="10" height="8.5" rx="2" />
      <path d="M8 2v2.5M6 8.25v1M10 8.25v1M1.5 8.5v2M14.5 8.5v2" />
    </>
  ),
  todo: (
    <>
      <path d="M2.25 4l1.25 1.25L5.75 3M2.25 9.5l1.25 1.25 2.25-2.25" />
      <path d="M8 4.25h6M8 9.75h6" />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.1 6.2a2 2 0 1 1 2.6 1.9c-.45.15-.7.5-.7.95v.45" />
      <path d="M8 11.4v.1" />
    </>
  ),
  plan: (
    <>
      <path d="M3 2.25h10v11.5H3z" />
      <path d="M5.5 5.25h5M5.5 8h5M5.5 10.75h3" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.9 2 1.9 10.5 0 12.5M8 1.75c-1.9 2-1.9 10.5 0 12.5" />
    </>
  ),
  skill: <path d="M8 1.75l1.7 4.1 4.3.4-3.3 2.8 1 4.2L8 11l-3.7 2.25 1-4.2L2 6.25l4.3-.4z" />,
  mcp: (
    <>
      <path d="M5.5 2v3M10.5 2v3M3.75 5h8.5v2.5a4.25 4.25 0 0 1-8.5 0z" />
      <path d="M8 11.75V14.5" />
    </>
  ),
  tool: <path d="M10.6 2.1a3.5 3.5 0 0 0-4.3 4.6L2.2 10.8a1.4 1.4 0 0 0 2 2l4.1-4.1a3.5 3.5 0 0 0 4.6-4.3l-2 2-1.9-.4-.4-1.9z" />,
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25H3.5A1.25 1.25 0 0 0 2.25 3.5v6a1.25 1.25 0 0 0 1.25 1.25h1.75" />
    </>
  ),
  check: <path d="M3 8.5l3 3 7-7" />,
  image: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <circle cx="5.5" cy="6.25" r="1.25" />
      <path d="M14.25 10.5l-3.5-3.5-6.5 6.25" />
    </>
  ),
  spark: <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.4 3.4l2.3 2.3M10.3 10.3l2.3 2.3M3.4 12.6l2.3-2.3M10.3 5.7l2.3-2.3" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `fd-icon ${className}` : 'fd-icon'}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`fd-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** Small spinning arc for calls and agents that are still running. */
export function Spinner() {
  return (
    <svg className="fd-spinner" width="12" height="12" viewBox="0 0 12 12" aria-label="Running">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
