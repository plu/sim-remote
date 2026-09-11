import type { TouchPhase } from '../../shared/protocol.ts';

export interface Handover {
  previous: string | null;
  synthesizeUp: { x: number; y: number } | null;
}

/**
 * One controller at a time. Everyone else is view-only *while someone holds
 * control*; when control is free, a touch claims it.
 */
export class ControlArbiter {
  #controller: string | null = null;
  #down = false;
  #last: { x: number; y: number } | null = null;

  get controller(): string | null { return this.#controller; }

  canAccept(clientId: string): boolean { return this.#controller === clientId; }

  claimIfFree(clientId: string): boolean {
    if (this.#controller !== null) return false;
    this.#controller = clientId;
    this.#resetGesture();
    return true;
  }

  noteTouch(clientId: string, phase: TouchPhase, x: number, y: number): void {
    if (this.#controller !== clientId) return;
    this.#last = { x, y };
    if (phase === 'down') this.#down = true;
    else if (phase === 'up') this.#down = false;
  }

  takeControl(clientId: string): Handover {
    const previous = this.#controller;
    if (previous === clientId) return { previous, synthesizeUp: null };
    const synthesizeUp = this.#heldFinger();
    this.#controller = clientId;
    this.#resetGesture();
    return { previous, synthesizeUp };
  }

  release(clientId: string): Handover {
    if (this.#controller !== clientId) return { previous: null, synthesizeUp: null };
    const synthesizeUp = this.#heldFinger();
    this.#controller = null;
    this.#resetGesture();
    return { previous: clientId, synthesizeUp };
  }

  /** A finger left down by the outgoing controller must be lifted, or the
   *  simulator stays stuck in a touch for every viewer. */
  #heldFinger(): { x: number; y: number } | null {
    return this.#down && this.#last ? { ...this.#last } : null;
  }

  #resetGesture(): void { this.#down = false; this.#last = null; }
}
