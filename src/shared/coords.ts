import type { ScreenPoints } from './protocol.ts';

export interface Rect { left: number; top: number; width: number; height: number }

/** idb HID coordinates are in POINTS; describe() reports pixels + density. */
export function pixelsToPoints(px: number, py: number, density: number): ScreenPoints {
  if (density <= 0) throw new Error(`invalid density: ${density}`);
  return { width: Math.round(px / density), height: Math.round(py / density) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function canvasToPoint(
  clientX: number, clientY: number, rect: Rect, screen: ScreenPoints,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  return {
    x: Math.round(clamp(fx * screen.width, 0, screen.width)),
    y: Math.round(clamp(fy * screen.height, 0, screen.height)),
  };
}
