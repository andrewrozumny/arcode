import { useRef } from 'react';
import type { PointerEvent } from 'react';

interface Props {
  orientation: 'vertical' | 'horizontal';
  /** Called with the pointer delta in px since the drag started. */
  onDrag(deltaPx: number): void;
  onDragEnd(): void;
  onDragStart(): void;
}

/** A 1px divider with a wider invisible hit area. Vertical = splits left/right. */
export function Splitter({ orientation, onDrag, onDragStart, onDragEnd }: Props) {
  const start = useRef<number | null>(null);
  const axis = (event: PointerEvent): number => (orientation === 'vertical' ? event.clientX : event.clientY);

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-orientation={orientation}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = axis(event);
        document.body.classList.add(`resizing-${orientation}`);
        onDragStart();
      }}
      onPointerMove={(event) => {
        if (start.current !== null) onDrag(axis(event) - start.current);
      }}
      onPointerUp={(event) => {
        if (start.current === null) return;
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove(`resizing-${orientation}`);
        onDragEnd();
      }}
    />
  );
}
