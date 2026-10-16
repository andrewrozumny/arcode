const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function PencilIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M2.5 13.5l.7-3L11 2.7a1.4 1.4 0 012 2L5.5 12.8l-3 .7z" />
      <path d="M9.8 3.9l2.3 2.3" />
    </svg>
  );
}

export function DiffIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M4 2v8M2 4l2-2 2 2M12 14V6M10 12l2 2 2-2" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base} width={10} height={10} aria-hidden>
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

export function SaveIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M3 2.5h8l2.5 2.5v8.5h-10.5z" />
      <path d="M5.5 2.5v3.5h4.5v-3.5M5.5 13.5v-4h5v4" />
    </svg>
  );
}

export function ZoomAreaIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M2 5V2h3M11 2h3v3M2 11v3h3" />
      <circle cx="10.5" cy="10.5" r="2.5" />
      <path d="M12.3 12.3L14.5 14.5" />
    </svg>
  );
}
