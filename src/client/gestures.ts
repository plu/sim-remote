import type { ClientMsg, ScreenPoints } from '../shared/protocol.ts';
import { canvasToPoint, type Rect } from '../shared/coords.ts';

export interface PointerLike { clientX: number; clientY: number; pointerId: number }
export interface WheelLike { clientX: number; clientY: number; deltaY: number; ctrlKey: boolean }

/**
 * Translates browser pointer events into wire messages. Drag and long-press
 * need no special cases: streaming real-time move events reproduces them
 * naturally on the simulator.
 */
export class GestureRecognizer {
  #screen: ScreenPoints;
  #getRect: () => Rect;
  #activePointer: number | null = null;
  #last: { x: number; y: number } | null = null;

  constructor(screen: ScreenPoints, getRect: () => Rect) {
    this.#screen = screen;
    this.#getRect = getRect;
  }

  #pt(e: { clientX: number; clientY: number }) {
    return canvasToPoint(e.clientX, e.clientY, this.#getRect(), this.#screen);
  }

  pointerDown(e: PointerLike): ClientMsg[] {
    if (this.#activePointer !== null) return [];   // single touch only
    this.#activePointer = e.pointerId;
    const { x, y } = this.#pt(e);
    this.#last = { x, y };
    return [{ type: 'touch', phase: 'down', x, y }];
  }

  pointerMove(e: PointerLike): ClientMsg[] {
    if (this.#activePointer !== e.pointerId) return [];
    const { x, y } = this.#pt(e);
    if (this.#last && this.#last.x === x && this.#last.y === y) return [];
    this.#last = { x, y };
    return [{ type: 'touch', phase: 'move', x, y }];
  }

  pointerUp(e: PointerLike): ClientMsg[] {
    if (this.#activePointer !== e.pointerId) return [];
    this.#activePointer = null;
    const { x, y } = this.#pt(e);
    this.#last = null;
    return [{ type: 'touch', phase: 'up', x, y }];
  }

  /** Browsers report trackpad pinch as a wheel event with ctrlKey set. */
  wheel(e: WheelLike): ClientMsg[] {
    if (!e.ctrlKey) return [];
    const { x, y } = this.#pt(e);
    return [{ type: 'pinch', x, y, scale: Math.exp(-e.deltaY / 100), duration: 0.2 }];
  }
}
