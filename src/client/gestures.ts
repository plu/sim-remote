import type { ClientMsg, ScreenPoints } from '../shared/protocol.ts';
import { canvasToPoint, type Rect } from '../shared/coords.ts';

export interface PointerLike { clientX: number; clientY: number; pointerId: number }
export interface WheelLike { clientX: number; clientY: number; deltaY: number; ctrlKey: boolean }

interface Pt { x: number; y: number }

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt) => ({ x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });

/**
 * Translates browser pointer events into wire messages.
 *
 * Drag and long-press need no special cases: streaming real-time move events
 * reproduces them naturally on the simulator.
 *
 * Pinch is different. idb's HIDTouch carries no finger identifier, so only one
 * touch point can be streamed at a time and two fingers cannot be tracked live.
 * Multi-touch must go through idb's canned HIDPinch, so a pinch is accumulated
 * here and emitted once, rather than streamed.
 */
export class GestureRecognizer {
  #screen: ScreenPoints;
  #getRect: () => Rect;

  #activePointer: number | null = null;
  #last: Pt | null = null;

  // Two-finger pinch state.
  #pointers = new Map<number, Pt>();
  #pinchStart: { a: Pt; b: Pt } | null = null;
  #pinchNow: { a: Pt; b: Pt } | null = null;

  // Trackpad pinch accumulates across wheel ticks.
  #pendingScale = 1;
  #pendingAt: Pt | null = null;

  constructor(screen: ScreenPoints, getRect: () => Rect) {
    this.#screen = screen;
    this.#getRect = getRect;
  }

  #pt(e: { clientX: number; clientY: number }): Pt {
    return canvasToPoint(e.clientX, e.clientY, this.#getRect(), this.#screen);
  }

  pointerDown(e: PointerLike): ClientMsg[] {
    const p = this.#pt(e);
    this.#pointers.set(e.pointerId, p);

    // Second finger: abandon the single-touch gesture and start a pinch.
    if (this.#pointers.size === 2) {
      const [a, b] = [...this.#pointers.values()] as [Pt, Pt];
      this.#pinchStart = { a, b };
      this.#pinchNow = { a, b };
      const held = this.#last;
      this.#activePointer = null;
      this.#last = null;
      // Release the held finger, or the simulator stays mid-drag.
      return held ? [{ type: 'touch', phase: 'up', x: held.x, y: held.y }] : [];
    }

    if (this.#pinchStart || this.#activePointer !== null) return [];
    this.#activePointer = e.pointerId;
    this.#last = p;
    return [{ type: 'touch', phase: 'down', x: p.x, y: p.y }];
  }

  pointerMove(e: PointerLike): ClientMsg[] {
    if (this.#pointers.has(e.pointerId)) this.#pointers.set(e.pointerId, this.#pt(e));

    if (this.#pinchStart) {
      if (this.#pointers.size >= 2) {
        const [a, b] = [...this.#pointers.values()] as [Pt, Pt];
        this.#pinchNow = { a, b };
      }
      return [];
    }

    if (this.#activePointer !== e.pointerId) return [];
    const p = this.#pt(e);
    if (this.#last && this.#last.x === p.x && this.#last.y === p.y) return [];
    this.#last = p;
    return [{ type: 'touch', phase: 'move', x: p.x, y: p.y }];
  }

  pointerUp(e: PointerLike): ClientMsg[] {
    this.#pointers.delete(e.pointerId);

    if (this.#pinchStart) {
      const start = this.#pinchStart;
      const now = this.#pinchNow ?? start;
      this.#pinchStart = null;
      this.#pinchNow = null;
      this.#activePointer = null;
      this.#last = null;

      const from = dist(start.a, start.b);
      const to = dist(now.a, now.b);
      if (from < 1) return [];
      const centre = mid(start.a, start.b);
      return [{
        type: 'pinch',
        x: centre.x,
        y: centre.y,
        scale: to / from,
        duration: 0.25,
        // Where the fingers actually started, but never so small that iOS's
        // pinch recogniser ignores the synthesised gesture.
        radius: Math.max(40, Math.round(from / 2)),
      }];
    }

    if (this.#activePointer !== e.pointerId) return [];
    this.#activePointer = null;
    const p = this.#pt(e);
    this.#last = null;
    return [{ type: 'touch', phase: 'up', x: p.x, y: p.y }];
  }

  /**
   * Browsers report trackpad pinch as a wheel event with ctrlKey set, at up to
   * ~60/s. Each one is accumulated; call takePinch() once the gesture settles.
   */
  wheel(e: WheelLike): ClientMsg[] {
    if (!e.ctrlKey) return [];
    this.#pendingAt = this.#pt(e);
    this.#pendingScale *= Math.exp(-e.deltaY / 100);
    return [];
  }

  /** The accumulated trackpad pinch, or null if none is pending. */
  takePinch(): ClientMsg | null {
    if (!this.#pendingAt || this.#pendingScale === 1) return null;
    const msg: ClientMsg = {
      type: 'pinch',
      x: this.#pendingAt.x,
      y: this.#pendingAt.y,
      scale: this.#pendingScale,
      duration: 0.25,
      radius: Math.round(Math.min(this.#screen.width, this.#screen.height) / 4),
    };
    this.#pendingScale = 1;
    this.#pendingAt = null;
    return msg;
  }
}
