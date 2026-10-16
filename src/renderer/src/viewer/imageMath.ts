/**
 * Pure geometry for the image viewer. A view places the image's top-left corner at (x, y)
 * in stage pixels and draws it at `scale` times its natural size, which maps directly onto
 * `transform: translate(x, y) scale(scale)` with a 0 0 origin.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 32;

/** Preset stops used by the zoom in / out buttons and keys. */
export const ZOOM_STEPS = [
  0.05, 0.1, 0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32,
];

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Largest scale that shows the whole image, never enlarging past its natural size. */
export function fitScale(image: Size, stage: Size): number {
  if (image.w <= 0 || image.h <= 0 || stage.w <= 0 || stage.h <= 0) return 1;
  return clampScale(Math.min(1, stage.w / image.w, stage.h / image.h));
}

/** One axis: centre the image when it is smaller than the stage, otherwise keep both edges covered. */
function clampAxis(offset: number, extent: number, stage: number): number {
  if (extent <= stage) return (stage - extent) / 2;
  return Math.min(0, Math.max(stage - extent, offset));
}

/** Keeps the image from leaving the stage: no gaps once it is larger, centred while smaller. */
export function clampView(view: View, image: Size, stage: Size): View {
  return {
    scale: view.scale,
    x: clampAxis(view.x, image.w * view.scale, stage.w),
    y: clampAxis(view.y, image.h * view.scale, stage.h),
  };
}

export function fitView(image: Size, stage: Size): View {
  return clampView({ scale: fitScale(image, stage), x: 0, y: 0 }, image, stage);
}

/** Rescales so the image point under `at` (stage pixels) stays under it, then clamps. */
export function zoomAt(view: View, at: Point, scale: number, image: Size, stage: Size): View {
  const next = clampScale(scale);
  const ratio = next / view.scale;
  return clampView(
    { scale: next, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio },
    image,
    stage,
  );
}

/** Puts image point `imagePoint` (natural pixels) at the stage centre at `scale`. */
export function centreOn(imagePoint: Point, scale: number, image: Size, stage: Size): View {
  const next = clampScale(scale);
  return clampView(
    { scale: next, x: stage.w / 2 - imagePoint.x * next, y: stage.h / 2 - imagePoint.y * next },
    image,
    stage,
  );
}

/** Stage point to image (natural pixel) coordinates. */
export function toImage(view: View, at: Point): Point {
  return { x: (at.x - view.x) / view.scale, y: (at.y - view.y) / view.scale };
}

export function panBy(view: View, dx: number, dy: number, image: Size, stage: Size): View {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, image, stage);
}

/** Zooms so a rectangle drawn on the stage fills it, centred on the rectangle's middle. */
export function zoomToRect(view: View, rect: Rect, image: Size, stage: Size): View {
  const w = Math.max(1, Math.abs(rect.w));
  const h = Math.max(1, Math.abs(rect.h));
  const left = Math.min(rect.x, rect.x + rect.w);
  const top = Math.min(rect.y, rect.y + rect.h);
  const scale = view.scale * Math.min(stage.w / w, stage.h / h);
  return centreOn(toImage(view, { x: left + w / 2, y: top + h / 2 }), scale, image, stage);
}

/** Keeps the image point at the stage centre in place when the stage changes size. */
export function resizeKeepCentre(view: View, before: Size, after: Size, image: Size): View {
  return clampView(
    { scale: view.scale, x: view.x + (after.w - before.w) / 2, y: view.y + (after.h - before.h) / 2 },
    image,
    after,
  );
}

/** Next preset stop above (dir 1) or below (dir -1) the current scale. */
export function stepScale(scale: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > scale + eps) ?? MAX_SCALE;
  return ZOOM_STEPS.findLast((s) => s < scale - eps) ?? MIN_SCALE;
}

export interface WheelInput {
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). */
  deltaMode: number;
  /** Trackpad pinch: Chromium reports it as a wheel event with ctrlKey set. */
  pinch: boolean;
}

/**
 * Multiplicative zoom for one wheel event. Pinches and fine trackpad deltas scale
 * exponentially so the motion feels continuous; line-mode or large integer deltas
 * (a notched mouse wheel) take a fixed step per notch.
 */
export function wheelZoomFactor({ deltaY, deltaMode, pinch }: WheelInput): number {
  if (deltaY === 0) return 1;
  let factor: number;
  if (pinch) factor = Math.exp(-deltaY * 0.01);
  else if (deltaMode !== 0 || (Math.abs(deltaY) >= 50 && Number.isInteger(deltaY))) {
    factor = deltaY < 0 ? 1.2 : 1 / 1.2;
  } else factor = Math.exp(-deltaY * 0.005);
  return Math.min(2, Math.max(0.5, factor));
}

/** Wheel deltas in pixels; line and page modes are converted with typical sizes. */
export function wheelPixels(delta: number, deltaMode: number, page: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * page;
  return delta;
}

/**
 * Where keyboard focus sits, from the image viewer's point of view: its stage, the page body,
 * another element inside the viewer (toolbar), a text field or editor, a button/link/select
 * outside the viewer, or anything else.
 */
export type ViewerFocus = 'stage' | 'body' | 'inside' | 'typing' | 'control' | 'other';

/**
 * Whether the viewer takes a key. `plain` keys (Space, Shift+digit) would otherwise activate a
 * focused button or type text, so they need focus on the stage, or on the page body with the
 * pointer over the image. Cmd shortcuts also work from the toolbar and, under the pointer, from
 * anywhere that is not a text field.
 */
export function viewerTakesKey(focus: ViewerFocus, hovered: boolean, plain: boolean): boolean {
  if (focus === 'stage') return true;
  if (plain) return focus === 'body' && hovered;
  if (focus === 'inside') return true;
  return hovered && focus !== 'typing';
}
