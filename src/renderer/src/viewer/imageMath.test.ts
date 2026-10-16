import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  centreOn,
  clampView,
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

const image = { w: 2000, h: 1000 };
const stage = { w: 800, h: 600 };

describe('fitScale', () => {
  it('shrinks a large image to the limiting side', () => {
    expect(fitScale(image, stage)).toBeCloseTo(0.4);
  });
  it('never enlarges a small image', () => {
    expect(fitScale({ w: 100, h: 50 }, stage)).toBe(1);
  });
  it('respects the minimum scale and empty sizes', () => {
    expect(fitScale({ w: 100000, h: 100000 }, stage)).toBe(MIN_SCALE);
    expect(fitScale(image, { w: 0, h: 0 })).toBe(1);
  });
});

describe('fitView', () => {
  it('centres the fitted image', () => {
    const view = fitView(image, stage);
    expect(view.x).toBeCloseTo(0);
    expect(view.y).toBeCloseTo((600 - 400) / 2);
  });
});

describe('clampView', () => {
  it('centres an axis that is smaller than the stage', () => {
    expect(clampView({ scale: 0.1, x: -500, y: 900 }, image, stage)).toEqual({ scale: 0.1, x: 300, y: 250 });
  });
  it('leaves no gap on an axis larger than the stage', () => {
    const view = clampView({ scale: 1, x: 100, y: -5000 }, image, stage);
    expect(view.x).toBe(0);
    expect(view.y).toBe(600 - 1000);
  });
});

describe('zoomAt', () => {
  it('keeps the image point under the cursor', () => {
    const start = { scale: 1, x: -600, y: -200 };
    const at = { x: 300, y: 250 };
    const before = toImage(start, at);
    const next = zoomAt(start, at, 2, image, stage);
    expect(next.scale).toBe(2);
    const after = toImage(next, at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('clamps the scale to the allowed range', () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 1000, image, stage).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 0, image, stage).scale).toBe(MIN_SCALE);
  });
});

describe('centreOn', () => {
  it('puts the image point in the middle of the stage', () => {
    const view = centreOn({ x: 1000, y: 500 }, 1, image, stage);
    expect(view).toEqual({ scale: 1, x: -600, y: -200 });
  });
  it('is clamped near the edges', () => {
    const view = centreOn({ x: 0, y: 0 }, 1, image, stage);
    expect(view.x).toBe(0);
    expect(view.y).toBe(0);
  });
});

describe('panBy', () => {
  it('moves and clamps', () => {
    const view = { scale: 1, x: -600, y: -200 };
    expect(panBy(view, 50, -30, image, stage)).toEqual({ scale: 1, x: -550, y: -230 });
    expect(panBy(view, 10000, 10000, image, stage)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('zoomToRect', () => {
  it('fills the stage with the selected area', () => {
    const view = { scale: 1, x: -600, y: -200 };
    // A 200x150 box centred on stage point (400, 300), which is image point (1000, 500).
    const next = zoomToRect(view, { x: 300, y: 225, w: 200, h: 150 }, image, stage);
    expect(next.scale).toBeCloseTo(4);
    const centre = toImage(next, { x: 400, y: 300 });
    expect(centre.x).toBeCloseTo(1000);
    expect(centre.y).toBeCloseTo(500);
  });
  it('accepts a rectangle drawn right to left', () => {
    const view = { scale: 1, x: -600, y: -200 };
    const a = zoomToRect(view, { x: 300, y: 225, w: 200, h: 150 }, image, stage);
    const b = zoomToRect(view, { x: 500, y: 375, w: -200, h: -150 }, image, stage);
    expect(b).toEqual(a);
  });
});

describe('resizeKeepCentre', () => {
  it('keeps the centred image point when the stage grows', () => {
    const view = { scale: 1, x: -600, y: -200 };
    const after = { w: 1000, h: 700 };
    const next = resizeKeepCentre(view, stage, after, image);
    const centre = toImage(next, { x: 500, y: 350 });
    expect(centre.x).toBeCloseTo(1000);
    expect(centre.y).toBeCloseTo(500);
  });
});

describe('stepScale', () => {
  it('moves to the next preset', () => {
    expect(stepScale(1, 1)).toBe(1.5);
    expect(stepScale(1, -1)).toBeCloseTo(2 / 3);
    expect(stepScale(0.4, 1)).toBe(0.5);
    expect(stepScale(0.4, -1)).toBeCloseTo(1 / 3);
  });
  it('stops at the ends', () => {
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(stepScale(MIN_SCALE, -1)).toBe(MIN_SCALE);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in on negative deltas and out on positive ones', () => {
    expect(wheelZoomFactor({ deltaY: -10, deltaMode: 0, pinch: true })).toBeGreaterThan(1);
    expect(wheelZoomFactor({ deltaY: 10, deltaMode: 0, pinch: true })).toBeLessThan(1);
    expect(wheelZoomFactor({ deltaY: 0, deltaMode: 0, pinch: true })).toBe(1);
  });
  it('is smooth for pinches and opposite pinches cancel out', () => {
    const a = wheelZoomFactor({ deltaY: 3.5, deltaMode: 0, pinch: true });
    const b = wheelZoomFactor({ deltaY: -3.5, deltaMode: 0, pinch: true });
    expect(a * b).toBeCloseTo(1);
    expect(a).toBeGreaterThan(0.9);
  });
  it('steps for a notched mouse wheel', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, pinch: false })).toBeCloseTo(1.2);
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 1, pinch: false })).toBeCloseTo(1 / 1.2);
  });
  it('limits one event to a factor of two', () => {
    expect(wheelZoomFactor({ deltaY: -1000, deltaMode: 0, pinch: true })).toBe(2);
    expect(wheelZoomFactor({ deltaY: 1000, deltaMode: 0, pinch: true })).toBe(0.5);
  });
});

describe('wheelPixels', () => {
  it('converts line and page deltas', () => {
    expect(wheelPixels(3, 0, 600)).toBe(3);
    expect(wheelPixels(3, 1, 600)).toBe(48);
    expect(wheelPixels(1, 2, 600)).toBe(600);
  });
});

describe('viewerTakesKey', () => {
  it('takes every key while the stage has focus', () => {
    expect(viewerTakesKey('stage', false, true)).toBe(true);
    expect(viewerTakesKey('stage', false, false)).toBe(true);
  });

  it('leaves Space and Shift+digit to a focused toolbar button', () => {
    expect(viewerTakesKey('inside', true, true)).toBe(false);
    expect(viewerTakesKey('inside', false, false)).toBe(true);
  });

  it('takes plain keys under the pointer only when focus is on the page body', () => {
    expect(viewerTakesKey('body', true, true)).toBe(true);
    expect(viewerTakesKey('body', false, true)).toBe(false);
    expect(viewerTakesKey('control', true, true)).toBe(false);
    expect(viewerTakesKey('other', true, true)).toBe(false);
  });

  it('takes Cmd shortcuts under the pointer unless typing goes elsewhere', () => {
    expect(viewerTakesKey('control', true, false)).toBe(true);
    expect(viewerTakesKey('other', true, false)).toBe(true);
    expect(viewerTakesKey('typing', true, false)).toBe(false);
    expect(viewerTakesKey('other', false, false)).toBe(false);
  });
});
