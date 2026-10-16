import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatSize } from '../format';
import { ZoomAreaIcon } from './Icons';
import {
  centreOn,
  fitScale,
  fitView,
  panBy,
  resizeKeepCentre,
  stepScale,
  toImage,
  viewerTakesKey,
  wheelPixels,
  wheelZoomFactor,
  zoomAt,
  zoomToRect,
} from './imageMath';
import type { Point, Size, View, ViewerFocus } from './imageMath';

interface Props {
  dataUrl: string;
  size: number;
  mime: string;
}

/** Commands the toolbar sends to the controller living in the setup effect. */
interface Controls {
  fit(): void;
  actual(): void;
  step(dir: 1 | -1): void;
  loaded(img: HTMLImageElement): void;
}

/** Smallest drag, in screen pixels, that counts as a zoom rectangle rather than a click. */
const MIN_AREA = 5;
/** Checker cell size on screen, kept constant at every zoom. */
const CHECKER = 16;

/**
 * Image preview with Preview-style navigation. The image is one element moved with a
 * translate + scale transform (see imageMath.ts); updates are batched per animation frame.
 *
 * Mouse: Cmd+wheel or pinch zooms around the pointer, wheel / two-finger scroll pans, drag or
 * Space+drag pans, Shift+drag (or the zoom-to-area tool) zooms to a rectangle, double-click
 * toggles fit and 100%. Keys, while the image has focus or the pointer (and no editor or
 * terminal focus): Cmd+0 fit, Cmd+= / Cmd+- zoom, Shift+0 100%, Shift+1 fit, Esc leaves the tool.
 */
export function ImageView({ dataUrl, size, mime }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const controls = useRef<Controls | null>(null);
  const areaRef = useRef(false);

  const [natural, setNatural] = useState<Size | null>(null);
  const [scale, setScale] = useState(1);
  const [fitted, setFitted] = useState(true);
  const [areaMode, setAreaMode] = useState(false);
  const [panning, setPanning] = useState(false);
  const [space, setSpace] = useState(false);

  useEffect(() => {
    areaRef.current = areaMode;
  }, [areaMode]);

  // A new picture stays hidden until loaded() has placed it; otherwise its first frame shows at the old transform.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img) img.style.visibility = 'hidden';
  }, [dataUrl]);

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const img = imgRef.current;
    const marquee = marqueeRef.current;
    if (!root || !stage || !img || !marquee) return;

    let image: Size | null = null;
    let view: View = { scale: 1, x: 0, y: 0 };
    let fit = true;
    let box: Size = { w: stage.clientWidth, h: stage.clientHeight };
    let frame = 0;
    let hovered = false;
    let spaceDown = false;
    let drag: { kind: 'pan'; last: Point } | { kind: 'area'; start: Point; end: Point } | null = null;

    const render = (): void => {
      frame = 0;
      const { scale: s, x, y } = view;
      // Whole pixels at the edges keep 100% sharp; the scale itself stays exact.
      img.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${s})`;
      img.style.imageRendering = s > 2 ? 'pixelated' : 'auto';
      const cell = CHECKER / s;
      img.style.backgroundSize = `${cell}px ${cell}px`;
      img.style.backgroundPosition = `0 0, ${cell / 2}px ${cell / 2}px`;
      const pannable = !!image && (image.w * s > box.w + 0.5 || image.h * s > box.h + 0.5);
      stage.dataset.pannable = String(pannable);
      setScale(s);
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    const apply = (next: View, isFit: boolean): void => {
      view = next;
      if (fit !== isFit) {
        fit = isFit;
        setFitted(isFit);
      }
      schedule();
    };

    const local = (event: { clientX: number; clientY: number }): Point => {
      const rect = stage.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const centre = (): Point => ({ x: box.w / 2, y: box.h / 2 });
    const zoomTo = (next: number, at: Point): void => {
      if (image) apply(zoomAt(view, at, next, image, box), false);
    };
    const toFit = (): void => {
      if (image) apply(fitView(image, box), true);
    };

    controls.current = {
      fit: toFit,
      actual: () => zoomTo(1, centre()),
      step: (dir) => zoomTo(stepScale(view.scale, dir), centre()),
      loaded: (el) => {
        const next = { w: el.naturalWidth || 300, h: el.naturalHeight || 150 };
        const same = image && image.w === next.w && image.h === next.h;
        image = next;
        setNatural(next);
        // A reload of the same picture (file watcher) keeps the current position.
        if (!same) fit = true;
        if (fit) view = fitView(next, box);
        setFitted(fit);
        render();
        img.style.visibility = 'visible';
      },
    };
    if (img.complete && img.naturalWidth) controls.current.loaded(img);

    const resize = new ResizeObserver(() => {
      const after = { w: stage.clientWidth, h: stage.clientHeight };
      if (after.w === box.w && after.h === box.h) return;
      const before = box;
      box = after;
      if (!image) return;
      view = fit ? fitView(image, box) : resizeKeepCentre(view, before, box, image);
      schedule();
    });
    resize.observe(stage);

    const onWheel = (event: WheelEvent): void => {
      if (!image) return;
      // Also stops Chromium's own page zoom on pinch.
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const factor = wheelZoomFactor({
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          pinch: event.ctrlKey,
        });
        if (factor !== 1) zoomTo(view.scale * factor, local(event));
        return;
      }
      let dx = wheelPixels(event.deltaX, event.deltaMode, box.w);
      let dy = wheelPixels(event.deltaY, event.deltaMode, box.h);
      // A plain mouse wheel with Shift scrolls sideways.
      if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      apply(panBy(view, -dx, -dy, image, box), fit);
    };

    const showMarquee = (a: Point, b: Point): void => {
      marquee.style.left = `${Math.min(a.x, b.x)}px`;
      marquee.style.top = `${Math.min(a.y, b.y)}px`;
      marquee.style.width = `${Math.abs(b.x - a.x)}px`;
      marquee.style.height = `${Math.abs(b.y - a.y)}px`;
      marquee.hidden = false;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !image) return;
      stage.focus({ preventScroll: true });
      const at = local(event);
      if (!spaceDown && (event.shiftKey || areaRef.current)) {
        drag = { kind: 'area', start: at, end: at };
      } else {
        drag = { kind: 'pan', last: { x: event.clientX, y: event.clientY } };
        setPanning(true);
      }
      stage.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!drag || !image) return;
      if (drag.kind === 'pan') {
        const dx = event.clientX - drag.last.x;
        const dy = event.clientY - drag.last.y;
        drag.last = { x: event.clientX, y: event.clientY };
        apply(panBy(view, dx, dy, image, box), fit);
      } else {
        drag.end = local(event);
        showMarquee(drag.start, drag.end);
      }
    };
    const onPointerUp = (event: PointerEvent): void => {
      const done = drag;
      drag = null;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      setPanning(false);
      marquee.hidden = true;
      if (!done || !image || done.kind !== 'area' || event.type === 'pointercancel') return;
      const w = done.end.x - done.start.x;
      const h = done.end.y - done.start.y;
      if (Math.abs(w) >= MIN_AREA && Math.abs(h) >= MIN_AREA) {
        apply(zoomToRect(view, { x: done.start.x, y: done.start.y, w, h }, image, box), false);
      } else if (areaRef.current) {
        // A plain click with the tool zooms in one step there, like Preview.
        zoomTo(stepScale(view.scale, 1), done.start);
      }
    };
    const onDoubleClick = (event: MouseEvent): void => {
      if (!image || areaRef.current || event.shiftKey) return;
      if (!fit) {
        toFit();
        return;
      }
      const target = fitScale(image, box) >= 1 ? 2 : 1;
      apply(centreOn(toImage(view, local(event)), target, image, box), false);
    };

    /** Keys apply while the image has focus, or under the pointer unless typing goes elsewhere. */
    const focusKind = (): ViewerFocus => {
      const active = document.activeElement;
      if (active === stage) return 'stage';
      if (!active || active === document.body) return 'body';
      if (active.closest('.terminal-dock, input, textarea, select, [contenteditable="true"], .cm-editor')) {
        return 'typing';
      }
      if (root.contains(active)) return 'inside';
      if (active.closest('button, [role="button"], a[href]')) return 'control';
      return 'other';
    };
    const setSpaceDown = (down: boolean): void => {
      if (spaceDown === down) return;
      spaceDown = down;
      setSpace(down);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!image) return;
      const { code, metaKey: meta, shiftKey: shift, altKey: alt, ctrlKey: ctrl } = event;
      // Space and Shift+digit would press a focused button or type text; Cmd shortcuts would not.
      const plain = !meta && !ctrl && !alt && (code === 'Space' || (shift && code.startsWith('Digit')));
      if (!viewerTakesKey(focusKind(), hovered, plain)) return;
      let handled = true;
      if (meta && !ctrl && !alt && code === 'Digit0') toFit();
      else if (meta && !ctrl && !alt && (code === 'Equal' || code === 'NumpadAdd')) {
        zoomTo(stepScale(view.scale, 1), centre());
      } else if (meta && !ctrl && !alt && (code === 'Minus' || code === 'NumpadSubtract')) {
        zoomTo(stepScale(view.scale, -1), centre());
      } else if (!meta && !ctrl && !alt && shift && code === 'Digit0') zoomTo(1, centre());
      else if (!meta && !ctrl && !alt && shift && code === 'Digit1') toFit();
      else if (!meta && !ctrl && !alt && !shift && code === 'Space') setSpaceDown(true);
      else if (code === 'Escape' && areaRef.current) setAreaMode(false);
      else handled = false;
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpaceDown(false);
    };
    const onBlur = (): void => setSpaceDown(false);
    const onEnter = (): void => {
      hovered = true;
    };
    const onLeave = (): void => {
      hovered = false;
    };

    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    stage.addEventListener('dblclick', onDoubleClick);
    root.addEventListener('pointerenter', onEnter);
    root.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      controls.current = null;
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', onPointerUp);
      stage.removeEventListener('pointercancel', onPointerUp);
      stage.removeEventListener('dblclick', onDoubleClick);
      root.removeEventListener('pointerenter', onEnter);
      root.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const stageClass = ['v-image-stage', areaMode && 'area', space && 'space', panning && 'panning']
    .filter(Boolean)
    .join(' ');

  return (
    <div className="v-image" ref={rootRef}>
      <div className="v-image-bar">
        <span className="v-muted">
          {natural ? `${natural.w} x ${natural.h}` : '...'} - {formatSize(size)} - {mime.replace('image/', '')}
        </span>
        <span className="v-spacer" />
        <button
          type="button"
          className={areaMode ? 'v-btn on' : 'v-btn'}
          onClick={() => setAreaMode((on) => !on)}
          title="Zoom to selection: drag a rectangle (or Shift+drag any time)"
        >
          <ZoomAreaIcon />
        </button>
        <button type="button" className="v-btn" onClick={() => controls.current?.step(-1)} title="Zoom out (Cmd+-)">
          -
        </button>
        <span className="v-muted v-zoom">{`${Math.round(scale * 100)}%`}</span>
        <button type="button" className="v-btn" onClick={() => controls.current?.step(1)} title="Zoom in (Cmd+=)">
          +
        </button>
        <button type="button" className="v-btn" onClick={() => controls.current?.actual()} title="Actual size (Shift+0)">
          100%
        </button>
        <button
          type="button"
          className={fitted ? 'v-btn on' : 'v-btn'}
          onClick={() => controls.current?.fit()}
          title="Fit to window (Cmd+0, Shift+1)"
        >
          Fit
        </button>
      </div>
      <div className={stageClass} ref={stageRef} tabIndex={0}>
        <img
          ref={imgRef}
          src={dataUrl}
          alt=""
          draggable={false}
          className="checker"
          onLoad={(event) => controls.current?.loaded(event.currentTarget)}
        />
        <div className="v-image-marquee" ref={marqueeRef} hidden />
      </div>
    </div>
  );
}
