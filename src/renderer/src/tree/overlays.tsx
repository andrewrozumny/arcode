import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

export type MenuItem =
  | { separator: true }
  | { label: string; run(): void; hint?: string; danger?: boolean; disabled?: boolean; separator?: false };

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (event: globalThis.MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ft-menu" style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="ft-menu-sep" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? 'ft-menu-item danger' : 'ft-menu-item'}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="ft-menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export interface PromptState {
  title: string;
  label?: string;
  /** Present for text prompts; omitted for plain confirmations. */
  initial?: string;
  confirmLabel: string;
  /** Resolves to an error message to keep the dialog open, or null on success. */
  onSubmit(value: string): Promise<string | null>;
}

export function PromptDialog({ state, onClose }: { state: PromptState; onClose(): void }): ReactElement {
  const [value, setValue] = useState(state.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasInput = state.initial !== undefined;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, []);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await state.onSubmit(value);
    setBusy(false);
    if (result) setError(result);
    else onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="ft-scrim" onMouseDown={onClose}>
      <div className="ft-dialog" role="dialog" aria-label={state.title} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="ft-dialog-title">{state.title}</div>
        {state.label && <div className="ft-dialog-label">{state.label}</div>}
        {hasInput && (
          <input
            ref={inputRef}
            className="ft-dialog-input"
            value={value}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        )}
        {error && <div className="ft-dialog-error">{error}</div>}
        <div className="ft-dialog-actions">
          <button type="button" className="ft-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ft-dialog-btn primary" autoFocus={!hasInput} disabled={busy} onClick={() => void submit()}>
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
