# sim-remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web page that streams a booted iOS simulator and accepts real touch input, so teammates without a Mac can drive a build from their browser.

**Architecture:** A Node/TypeScript server supervises one `idb_companion` gRPC daemon per simulator, holding a single long-lived HID stream and a single H264 video stream per simulator. Video NAL units fan out over a WebSocket to many viewers; input flows back over a second WebSocket, gated by a single-controller arbiter. The browser decodes H264 with WebCodecs onto a canvas.

**Tech Stack:** Node 26, TypeScript (strict), `@grpc/grpc-js`, `@grpc/proto-loader`, `ws`, Vite, Vitest.

## Global Constraints

- Node 26.8.1, pinned via `mise.toml`. TypeScript `strict: true`.
- Requires `idb_companion` >= 1.5.7 (`brew tap facebook/fb && brew install idb-companion`).
- **HID coordinates are in POINTS, never pixels.** `describe()` returns pixels + density; points = pixels / density. For iPhone 17 Pro: 1206x2622 px, density 3, points 402x874.
- **H264 only.** MJPEG is unavailable — VideoToolbox on Apple Silicon has no MJPEG encoder and the companion fails with `-12902`.
- **`scale_factor` must yield EVEN output pixel dimensions**, or the compression session fails with `-12902`.
- Video stream params: `format: H264`, `fps: 30`, `key_frame_rate: 30`, `avg_bitrate: 4_000_000`.
- Token auth ON by default; `--no-auth` opts out.
- One controller at a time. A client is view-only **only while another client holds control**; when control is free, a touch claims it.

---

### Task 1: Project scaffold and shared protocol

**Files:**
- Create: `mise.toml`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `proto/idb.proto` (vendored from facebook/idb `main`)
- Create: `src/shared/protocol.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Produces: `ClientMsg`, `ServerMsg`, `ScreenPoints`, `HardwareButton`, `Orientation` — imported by every later task.

- [ ] **Step 1: Create `mise.toml`**

```toml
[tools]
node = "26.8.1"
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "sim-remote",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --experimental-strip-types src/server/index.ts",
    "build:client": "vite build",
    "test": "vitest run",
    "test:live": "vitest run --config vitest.live.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@grpc/grpc-js": "^1.12.0",
    "@grpc/proto-loader": "^0.7.13",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/ws": "^8.5.12",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node", "vitest/globals"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Create `vitest.config.ts` and `.gitignore`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, include: ['tests/**/*.test.ts'], exclude: ['tests/live/**'] },
});
```

`.gitignore`:
```
node_modules/
dist/
*.log
.sim-remote/
```

- [ ] **Step 5: Vendor the proto**

```bash
mkdir -p proto
curl -fsSL -o proto/idb.proto https://raw.githubusercontent.com/facebook/idb/main/proto/idb.proto
grep -c 'rpc hid' proto/idb.proto   # expect 1
```

- [ ] **Step 6: Write `src/shared/protocol.ts`**

```ts
export interface ScreenPoints { width: number; height: number }

export type HardwareButton = 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'SIRI';
export type Orientation =
  | 'PORTRAIT' | 'PORTRAIT_UPSIDE_DOWN' | 'LANDSCAPE_LEFT' | 'LANDSCAPE_RIGHT';
export type TouchPhase = 'down' | 'move' | 'up';

export type ClientMsg =
  | { type: 'touch'; phase: TouchPhase; x: number; y: number }
  | { type: 'button'; button: HardwareButton }
  | { type: 'key'; keycode: number }
  | { type: 'text'; text: string }
  | { type: 'orientation'; orientation: Orientation }
  | { type: 'pinch'; x: number; y: number; scale: number; duration: number }
  | { type: 'takeControl' }
  | { type: 'setName'; name: string };

export type ConnState = 'connected' | 'reconnecting' | 'simulator-gone';

export type ServerMsg =
  | { type: 'hello'; udid: string; clientId: string; name: string; screen: ScreenPoints }
  | { type: 'control'; controllerId: string | null; controllerName: string | null }
  | { type: 'toast'; text: string }
  | { type: 'status'; state: ConnState };

export function isClientMsg(v: unknown): v is ClientMsg {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === 'string' && [
    'touch', 'button', 'key', 'text', 'orientation', 'pinch', 'takeControl', 'setName',
  ].includes(t);
}
```

- [ ] **Step 7: Write the failing test `tests/protocol.test.ts`**

```ts
import { isClientMsg } from '../src/shared/protocol.js';

test('accepts a touch message', () => {
  expect(isClientMsg({ type: 'touch', phase: 'down', x: 1, y: 2 })).toBe(true);
});
test('rejects unknown and malformed input', () => {
  expect(isClientMsg({ type: 'nope' })).toBe(false);
  expect(isClientMsg(null)).toBe(false);
  expect(isClientMsg('touch')).toBe(false);
});
```

- [ ] **Step 8: Install and verify**

Run: `mise x -- npm install && mise x -- npm test && mise x -- npm run typecheck`
Expected: tests PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: scaffold sim-remote with shared protocol types"
```

---

### Task 2: Coordinate mapping

**Files:**
- Create: `src/shared/coords.ts`
- Test: `tests/coords.test.ts`

**Interfaces:**
- Consumes: `ScreenPoints` from Task 1.
- Produces: `pixelsToPoints(px, py, density) => ScreenPoints`, `canvasToPoint(clientX, clientY, rect, screen) => {x,y}`.

- [ ] **Step 1: Write the failing test `tests/coords.test.ts`**

```ts
import { pixelsToPoints, canvasToPoint } from '../src/shared/coords.js';

test('converts iPhone 17 Pro pixels to points', () => {
  expect(pixelsToPoints(1206, 2622, 3)).toEqual({ width: 402, height: 874 });
});

test('density 1 is identity', () => {
  expect(pixelsToPoints(800, 600, 1)).toEqual({ width: 800, height: 600 });
});

const screen = { width: 402, height: 874 };
const rect = { left: 0, top: 0, width: 402, height: 874 };

test('maps canvas position to points 1:1 when rect matches point size', () => {
  expect(canvasToPoint(201, 437, rect, screen)).toEqual({ x: 201, y: 437 });
});

test('scales when the canvas is displayed smaller than the point size', () => {
  const small = { left: 0, top: 0, width: 201, height: 437 };
  expect(canvasToPoint(100.5, 218.5, small, screen)).toEqual({ x: 201, y: 874 });
});

test('accounts for rect offset', () => {
  const offset = { left: 50, top: 20, width: 402, height: 874 };
  expect(canvasToPoint(60, 30, offset, screen)).toEqual({ x: 10, y: 10 });
});

test('clamps out-of-bounds positions into the screen', () => {
  expect(canvasToPoint(-30, 99999, rect, screen)).toEqual({ x: 0, y: 874 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise x -- npx vitest run tests/coords.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/shared/coords.ts`**

```ts
import type { ScreenPoints } from './protocol.js';

export interface Rect { left: number; top: number; width: number; height: number }

/** idb HID coordinates are in POINTS. describe() reports pixels + density. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `mise x -- npx vitest run tests/coords.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: point-space coordinate mapping"
```

---

### Task 3: H264 Annex-B NAL unit parsing

**Files:**
- Create: `src/server/video/nalu.ts`
- Test: `tests/nalu.test.ts`

**Interfaces:**
- Produces: `NAL_SPS`, `NAL_PPS`, `NAL_IDR`, `nalType(u8)`, `isKeyframe(u8)`, `codecStringFromSps(u8)`, `class NaluSplitter { push(chunk: Uint8Array): Uint8Array[] }`.
- Each returned NAL unit **excludes** its Annex-B start code.

- [ ] **Step 1: Write the failing test `tests/nalu.test.ts`**

```ts
import { NaluSplitter, nalType, isKeyframe, codecStringFromSps, NAL_SPS, NAL_IDR } from '../src/server/video/nalu.js';

const sc4 = [0, 0, 0, 1];
const sc3 = [0, 0, 1];
const u8 = (...n: number[]) => new Uint8Array(n);

test('nalType reads the low 5 bits of the header byte', () => {
  expect(nalType(u8(0x67, 0x42))).toBe(NAL_SPS);   // 0x67 & 0x1f = 7
  expect(nalType(u8(0x65, 0x88))).toBe(NAL_IDR);   // 0x65 & 0x1f = 5
});

test('isKeyframe is true only for IDR', () => {
  expect(isKeyframe(u8(0x65))).toBe(true);
  expect(isKeyframe(u8(0x41))).toBe(false);        // non-IDR slice, type 1
});

test('splits multiple NAL units in one chunk, stripping start codes', () => {
  const s = new NaluSplitter();
  const out = s.push(u8(...sc4, 0x67, 0xAA, ...sc3, 0x68, 0xBB));
  expect(out.length).toBe(2);
  expect(Array.from(out[0]!)).toEqual([0x67, 0xAA]);
  expect(Array.from(out[1]!)).toEqual([0x68, 0xBB]);
});

test('reassembles a NAL unit split across chunk boundaries', () => {
  const s = new NaluSplitter();
  expect(s.push(u8(...sc4, 0x67, 0xAA)).length).toBe(0);   // no next start code yet
  const out = s.push(u8(0xBB, ...sc4, 0x65, 0xCC));
  expect(out.length).toBe(1);
  expect(Array.from(out[0]!)).toEqual([0x67, 0xAA, 0xBB]);
});

test('handles a start code straddling two chunks', () => {
  const s = new NaluSplitter();
  s.push(u8(...sc4, 0x67, 0xAA));
  const out = s.push(u8(0x00, 0x00, 0x00, 0x01, 0x65, 0xDD));
  expect(Array.from(out[0]!)).toEqual([0x67, 0xAA]);
});

test('ignores leading bytes before the first start code', () => {
  const s = new NaluSplitter();
  const out = s.push(u8(0xFF, 0xFE, ...sc4, 0x67, 0x01, ...sc4, 0x68, 0x02));
  expect(out.length).toBe(2);
  expect(Array.from(out[0]!)).toEqual([0x67, 0x01]);
});

test('builds an avc1 codec string from SPS profile/constraints/level', () => {
  // header 0x67, profile_idc 0x42 (baseline), constraints 0xE0, level_idc 0x1E (3.0)
  expect(codecStringFromSps(u8(0x67, 0x42, 0xE0, 0x1E))).toBe('avc1.42E01E');
  // High profile 0x64, constraints 0x00, level 0x28 (4.0)
  expect(codecStringFromSps(u8(0x67, 0x64, 0x00, 0x28))).toBe('avc1.640028');
});

test('codecStringFromSps rejects a too-short SPS', () => {
  expect(() => codecStringFromSps(u8(0x67, 0x42))).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise x -- npx vitest run tests/nalu.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/video/nalu.ts`**

```ts
export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

export function nalType(nalu: Uint8Array): number {
  return (nalu[0] ?? 0) & 0x1f;
}

export function isKeyframe(nalu: Uint8Array): boolean {
  return nalType(nalu) === NAL_IDR;
}

/** WebCodecs config string, e.g. 'avc1.42E01E'. Bytes 1..3 of the SPS NAL unit. */
export function codecStringFromSps(sps: Uint8Array): string {
  if (sps.length < 4) throw new Error('SPS too short to derive codec string');
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
}

/**
 * Streaming Annex-B splitter. Emits NAL units without start codes.
 * A unit is only emitted once the NEXT start code is seen, so the tail is
 * held until more data arrives.
 */
export class NaluSplitter {
  #buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf, 0);
    merged.set(chunk, this.#buf.length);

    const starts: Array<{ at: number; len: number }> = [];
    for (let i = 0; i + 2 < merged.length; i++) {
      if (merged[i] === 0 && merged[i + 1] === 0) {
        if (merged[i + 2] === 1) starts.push({ at: i, len: 3 });
        else if (merged[i + 2] === 0 && merged[i + 3] === 1) starts.push({ at: i, len: 4 });
      }
    }

    if (starts.length === 0) { this.#buf = merged; return []; }

    const out: Uint8Array[] = [];
    for (let k = 0; k + 1 < starts.length; k++) {
      const s = starts[k]!, next = starts[k + 1]!;
      const unit = merged.slice(s.at + s.len, next.at);
      if (unit.length > 0) out.push(unit);
    }
    const last = starts[starts.length - 1]!;
    this.#buf = merged.slice(last.at);
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `mise x -- npx vitest run tests/nalu.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: streaming Annex-B NAL unit splitter"
```

---

### Task 4: Control arbiter

**Files:**
- Create: `src/server/session/arbiter.ts`
- Test: `tests/arbiter.test.ts`

**Interfaces:**
- Produces: `class ControlArbiter` with `controller: string | null`, `noteTouch(id, phase, x, y)`, `canAccept(id)`, `claimIfFree(id)`, `takeControl(id)`, `release(id)`. `takeControl` and `release` return `{ previous: string | null; synthesizeUp: { x: number; y: number } | null }`.

- [ ] **Step 1: Write the failing test `tests/arbiter.test.ts`**

```ts
import { ControlArbiter } from '../src/server/session/arbiter.js';

test('starts with nobody driving', () => {
  expect(new ControlArbiter().controller).toBeNull();
});

test('claim-by-interaction: first toucher becomes controller', () => {
  const a = new ControlArbiter();
  expect(a.claimIfFree('alice')).toBe(true);
  expect(a.controller).toBe('alice');
});

test('claimIfFree does not steal from an existing controller', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  expect(a.claimIfFree('bob')).toBe(false);
  expect(a.controller).toBe('alice');
});

test('only the controller is accepted', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  expect(a.canAccept('alice')).toBe(true);
  expect(a.canAccept('bob')).toBe(false);
});

test('takeControl transfers immediately', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  const r = a.takeControl('bob');
  expect(r.previous).toBe('alice');
  expect(a.controller).toBe('bob');
});

test('takeControl mid-gesture synthesizes an UP at the last point', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  a.noteTouch('alice', 'down', 10, 20);
  a.noteTouch('alice', 'move', 30, 40);
  expect(a.takeControl('bob').synthesizeUp).toEqual({ x: 30, y: 40 });
});

test('takeControl after a completed gesture synthesizes nothing', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  a.noteTouch('alice', 'down', 10, 20);
  a.noteTouch('alice', 'up', 10, 20);
  expect(a.takeControl('bob').synthesizeUp).toBeNull();
});

test('release by the controller frees control and lifts a held finger', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  a.noteTouch('alice', 'down', 7, 8);
  const r = a.release('alice');
  expect(r.synthesizeUp).toEqual({ x: 7, y: 8 });
  expect(a.controller).toBeNull();
});

test('release by a non-controller is a no-op', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  const r = a.release('bob');
  expect(r.synthesizeUp).toBeNull();
  expect(a.controller).toBe('alice');
});

test('control is claimable again after release', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  a.release('alice');
  expect(a.claimIfFree('bob')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise x -- npx vitest run tests/arbiter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/session/arbiter.ts`**

```ts
import type { TouchPhase } from '../../shared/protocol.js';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `mise x -- npx vitest run tests/arbiter.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: single-controller arbiter with stuck-finger safety"
```

---

### Task 5: Gesture recognizer

**Files:**
- Create: `src/client/gestures.ts`
- Test: `tests/gestures.test.ts`

**Interfaces:**
- Consumes: `ClientMsg`, `canvasToPoint`, `Rect`.
- Produces: `class GestureRecognizer` constructed with `(screen: ScreenPoints, getRect: () => Rect)`, methods `pointerDown(e)`, `pointerMove(e)`, `pointerUp(e)`, `wheel(e)`, each returning `ClientMsg[]`. Input events are the minimal shape `{ clientX, clientY, pointerId }` (plus `ctrlKey`/`deltaY` for wheel) so they are testable without a DOM.

- [ ] **Step 1: Write the failing test `tests/gestures.test.ts`**

```ts
import { GestureRecognizer } from '../src/client/gestures.js';

const screen = { width: 402, height: 874 };
const rect = { left: 0, top: 0, width: 402, height: 874 };
const mk = () => new GestureRecognizer(screen, () => rect);
const p = (x: number, y: number, pointerId = 1) => ({ clientX: x, clientY: y, pointerId });

test('a tap emits down then up at the same point', () => {
  const g = mk();
  expect(g.pointerDown(p(100, 200))).toEqual([{ type: 'touch', phase: 'down', x: 100, y: 200 }]);
  expect(g.pointerUp(p(100, 200))).toEqual([{ type: 'touch', phase: 'up', x: 100, y: 200 }]);
});

test('moves are ignored unless a pointer is down', () => {
  expect(mk().pointerMove(p(50, 50))).toEqual([]);
});

test('a drag emits a move stream between down and up', () => {
  const g = mk();
  g.pointerDown(p(100, 600));
  expect(g.pointerMove(p(100, 500))).toEqual([{ type: 'touch', phase: 'move', x: 100, y: 500 }]);
  expect(g.pointerMove(p(100, 400))).toEqual([{ type: 'touch', phase: 'move', x: 100, y: 400 }]);
  expect(g.pointerUp(p(100, 400))).toEqual([{ type: 'touch', phase: 'up', x: 100, y: 400 }]);
});

test('a move to the same point is suppressed as redundant', () => {
  const g = mk();
  g.pointerDown(p(100, 600));
  expect(g.pointerMove(p(100, 600))).toEqual([]);
});

test('an up without a down emits nothing', () => {
  expect(mk().pointerUp(p(10, 10))).toEqual([]);
});

test('a second pointer does not start a competing gesture', () => {
  const g = mk();
  g.pointerDown(p(100, 200, 1));
  expect(g.pointerDown(p(300, 400, 2))).toEqual([]);
  expect(g.pointerUp(p(300, 400, 2))).toEqual([]);
  expect(g.pointerUp(p(100, 200, 1))).toEqual([{ type: 'touch', phase: 'up', x: 100, y: 200 }]);
});

test('ctrl+wheel becomes a pinch centred on the cursor', () => {
  const g = mk();
  const out = g.wheel({ clientX: 201, clientY: 437, deltaY: -100, ctrlKey: true });
  expect(out.length).toBe(1);
  const m = out[0]!;
  expect(m.type).toBe('pinch');
  if (m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.x).toBe(201);
  expect(m.y).toBe(437);
  expect(m.scale).toBeGreaterThan(1);   // negative deltaY zooms in
});

test('plain wheel without ctrl is not a pinch', () => {
  expect(mk().wheel({ clientX: 10, clientY: 10, deltaY: -100, ctrlKey: false })).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise x -- npx vitest run tests/gestures.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/client/gestures.ts`**

```ts
import type { ClientMsg, ScreenPoints } from '../shared/protocol.js';
import { canvasToPoint, type Rect } from '../shared/coords.js';

interface PointerLike { clientX: number; clientY: number; pointerId: number }
interface WheelLike { clientX: number; clientY: number; deltaY: number; ctrlKey: boolean }

/**
 * Translates browser pointer events into wire messages.
 * Drag and long-press need no special cases: streaming real-time move events
 * reproduces them naturally on the simulator.
 */
export class GestureRecognizer {
  #activePointer: number | null = null;
  #last: { x: number; y: number } | null = null;

  constructor(
    private readonly screen: ScreenPoints,
    private readonly getRect: () => Rect,
  ) {}

  #pt(e: { clientX: number; clientY: number }) {
    return canvasToPoint(e.clientX, e.clientY, this.getRect(), this.screen);
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
    const scale = Math.exp(-e.deltaY / 100);
    return [{ type: 'pinch', x, y, scale, duration: 0.2 }];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `mise x -- npx vitest run tests/gestures.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pointer-to-HID gesture recognizer"
```

---

### Task 6: Simulator discovery and companion supervisor

**Files:**
- Create: `src/server/companion/discovery.ts`, `src/server/companion/supervisor.ts`
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Produces: `parseBootedDevices(simctlJson: string): BootedSim[]` where `BootedSim = { udid: string; name: string; runtime: string }`; `listBootedSims(): Promise<BootedSim[]>`; `class CompanionSupervisor` with `socketFor(udid): Promise<string>`, `stop(udid)`, `stopAll()`.
- The supervisor spawns `idb_companion --udid <udid> --grpc-domain-sock <path>` and resolves once the socket file exists.

- [ ] **Step 1: Write the failing test `tests/discovery.test.ts`**

```ts
import { parseBootedDevices } from '../src/server/companion/discovery.js';

const sample = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'AAA', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
      { udid: 'BBB', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
      { udid: 'CCC', name: 'iPad', state: 'Booted', isAvailable: false },
    ],
  },
});

test('returns only booted, available devices', () => {
  const out = parseBootedDevices(sample);
  expect(out).toEqual([{ udid: 'AAA', name: 'iPhone 17 Pro', runtime: 'iOS 26.5' }]);
});

test('tolerates empty device sets', () => {
  expect(parseBootedDevices(JSON.stringify({ devices: {} }))).toEqual([]);
});

test('throws a clear error on malformed json', () => {
  expect(() => parseBootedDevices('not json')).toThrow(/simctl/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise x -- npx vitest run tests/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/companion/discovery.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BootedSim { udid: string; name: string; runtime: string }

/** 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' -> 'iOS 26.5' */
function prettyRuntime(key: string): string {
  const tail = key.split('.').pop() ?? key;
  const m = /^([A-Za-z]+)-(.+)$/.exec(tail);
  return m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : tail;
}

export function parseBootedDevices(simctlJson: string): BootedSim[] {
  let parsed: unknown;
  try { parsed = JSON.parse(simctlJson); }
  catch { throw new Error('could not parse simctl device list output'); }

  const devices = (parsed as { devices?: Record<string, unknown[]> }).devices ?? {};
  const out: BootedSim[] = [];
  for (const [runtimeKey, list] of Object.entries(devices)) {
    for (const d of list as Array<Record<string, unknown>>) {
      if (d.state === 'Booted' && d.isAvailable !== false) {
        out.push({
          udid: String(d.udid),
          name: String(d.name),
          runtime: prettyRuntime(runtimeKey),
        });
      }
    }
  }
  return out;
}

export async function listBootedSims(): Promise<BootedSim[]> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json']);
  return parseBootedDevices(stdout);
}
```

- [ ] **Step 4: Write `src/server/companion/supervisor.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Entry { proc: ChildProcess; socket: string; ready: Promise<string> }

const SOCK_DIR = join(tmpdir(), 'sim-remote');

/** Spawns and supervises one idb_companion per simulator. */
export class CompanionSupervisor {
  #entries = new Map<string, Entry>();
  #stopping = new Set<string>();

  async socketFor(udid: string): Promise<string> {
    const existing = this.#entries.get(udid);
    if (existing) return existing.ready;
    return this.#spawn(udid).ready;
  }

  #spawn(udid: string): Entry {
    mkdirSync(SOCK_DIR, { recursive: true });
    const socket = join(SOCK_DIR, `${udid}.sock`);
    rmSync(socket, { force: true });

    const proc = spawn('idb_companion', [
      '--udid', udid,
      '--grpc-domain-sock', socket,
      '--log-level', 'info',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const ready = new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (existsSync(socket)) { clearInterval(poll); resolve(socket); }
        else if (Date.now() - started > 20_000) {
          clearInterval(poll);
          reject(new Error(`idb_companion for ${udid} did not create a socket in 20s`));
        }
      }, 100);
      proc.on('error', (e) => { clearInterval(poll); reject(e); });
      proc.on('exit', (code) => {
        clearInterval(poll);
        if (!existsSync(socket)) reject(new Error(`idb_companion exited (${code})`));
      });
    });

    proc.on('exit', () => {
      this.#entries.delete(udid);
      rmSync(socket, { force: true });
      if (!this.#stopping.has(udid)) {
        // Crash, not a requested stop: bring it back for the next request.
        console.warn(`[supervisor] companion for ${udid} exited; will respawn on demand`);
      }
    });

    const entry: Entry = { proc, socket, ready };
    this.#entries.set(udid, entry);
    return entry;
  }

  stop(udid: string): void {
    const e = this.#entries.get(udid);
    if (!e) return;
    this.#stopping.add(udid);
    e.proc.kill('SIGTERM');
    this.#entries.delete(udid);
  }

  stopAll(): void { for (const udid of [...this.#entries.keys()]) this.stop(udid); }
}
```

- [ ] **Step 5: Run tests**

Run: `mise x -- npx vitest run tests/discovery.test.ts && mise x -- npm run typecheck`
Expected: PASS (3 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: simulator discovery and idb_companion supervisor"
```

---

### Task 7: Typed idb gRPC client

**Files:**
- Create: `src/server/idb/client.ts`
- Test: `tests/live/idb-client.live.test.ts`, `vitest.live.config.ts`

**Interfaces:**
- Consumes: `proto/idb.proto`, supervisor socket paths.
- Produces: `class IdbClient` with `static connect(socketPath): IdbClient`, `describe(): Promise<{ screen: ScreenPoints; name: string }>`, `openHid(): HidStream`, `startVideo(onNal, onError): VideoHandle`, `accessibilityInfo(): Promise<string>`, `screenshot(): Promise<Buffer>`, `close()`.
- `HidStream` has `touch(phase, x, y)`, `button(b)`, `key(code)`, `pinch(x,y,scale,duration)`, `orientation(o)`, `end()`.
- Live tests require a booted simulator and are excluded from `npm test`.

- [ ] **Step 1: Create `vitest.live.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, include: ['tests/live/**/*.live.test.ts'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
```

- [ ] **Step 2: Write `src/server/idb/client.ts`**

```ts
import { credentials, loadPackageDefinition, type Client, type ClientWritableStream } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { HardwareButton, Orientation, ScreenPoints, TouchPhase } from '../../shared/protocol.js';
import { pixelsToPoints } from '../../shared/coords.js';

const PROTO = join(dirname(fileURLToPath(import.meta.url)), '../../../proto/idb.proto');

/* eslint-disable @typescript-eslint/no-explicit-any */
const def = loadSync(PROTO, { keepCase: true, longs: String, defaults: true });
const idb = loadPackageDefinition(def).idb as any;

const point = (x: number, y: number) => ({ x, y });
const press = (action: unknown, direction: 'DOWN' | 'UP') => ({ press: { action, direction } });

export interface HidStream {
  touch(phase: TouchPhase, x: number, y: number): void;
  button(b: HardwareButton): void;
  key(code: number): void;
  pinch(x: number, y: number, scale: number, duration: number): void;
  orientation(o: Orientation): void;
  end(): void;
}

export interface VideoHandle { stop(): void }

export class IdbClient {
  private constructor(private readonly raw: Client & Record<string, any>) {}

  static connect(socketPath: string): IdbClient {
    return new IdbClient(new idb.CompanionService(`unix://${socketPath}`, credentials.createInsecure()));
  }

  describe(): Promise<{ screen: ScreenPoints; name: string }> {
    return new Promise((resolve, reject) => {
      this.raw.describe({}, (err: Error | null, r: any) => {
        if (err) return reject(err);
        const d = r.target_description;
        const dim = d?.screen_dimensions;
        if (!dim) return reject(new Error('simulator reported no screen dimensions'));
        resolve({
          name: String(d.name ?? 'Simulator'),
          screen: pixelsToPoints(Number(dim.width), Number(dim.height), Number(dim.density) || 1),
        });
      });
    });
  }

  /** One long-lived client-streaming HID call carries every input event. */
  openHid(onError: (e: Error) => void): HidStream {
    const call: ClientWritableStream<any> = this.raw.hid((err: Error | null) => { if (err) onError(err); });
    const w = (ev: unknown) => { try { call.write(ev); } catch (e) { onError(e as Error); } };
    return {
      touch: (phase, x, y) =>
        w(press({ touch: { point: point(x, y) } }, phase === 'up' ? 'UP' : 'DOWN')),
      button: (b) => { w(press({ button: { button: b } }, 'DOWN')); w(press({ button: { button: b } }, 'UP')); },
      key: (code) => { w(press({ key: { keycode: code } }, 'DOWN')); w(press({ key: { keycode: code } }, 'UP')); },
      pinch: (x, y, scale, duration) => w({ pinch: { center: point(x, y), scale, duration, radius: 100 } }),
      orientation: (o) => w({ orientation: { orientation: o } }),
      end: () => { try { call.end(); } catch { /* already closed */ } },
    };
  }

  startVideo(onNal: (chunk: Buffer) => void, onError: (e: Error) => void): VideoHandle {
    const call = this.raw.video_stream();
    call.on('data', (m: any) => { if (m?.payload?.data?.length) onNal(m.payload.data as Buffer); });
    call.on('error', (e: Error) => onError(e));
    call.write({ start: { fps: 30, format: 'H264', compression_quality: 0.7, scale_factor: 1.0, avg_bitrate: 4_000_000, key_frame_rate: 30 } });
    return {
      stop: () => { try { call.write({ stop: {} }); call.end(); } catch { /* already closed */ } },
    };
  }

  accessibilityInfo(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.raw.accessibility_info({ format: 'NESTED' }, (err: Error | null, r: any) =>
        err ? reject(err) : resolve(String(r.json ?? '')));
    });
  }

  screenshot(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.raw.screenshot({}, (err: Error | null, r: any) =>
        err ? reject(err) : resolve(r.image_data as Buffer));
    });
  }

  close(): void { this.raw.close?.(); }
}
```

- [ ] **Step 3: Write the live test `tests/live/idb-client.live.test.ts`**

```ts
import { CompanionSupervisor } from '../../src/server/companion/supervisor.js';
import { listBootedSims } from '../../src/server/companion/discovery.js';
import { IdbClient } from '../../src/server/idb/client.js';

let sup: CompanionSupervisor; let client: IdbClient; let udid: string;

beforeAll(async () => {
  const sims = await listBootedSims();
  if (sims.length === 0) throw new Error('live tests need a booted simulator');
  udid = sims[0]!.udid;
  sup = new CompanionSupervisor();
  client = IdbClient.connect(await sup.socketFor(udid));
});
afterAll(() => { client?.close(); sup?.stopAll(); });

test('describe reports a sane point-space screen', async () => {
  const { screen } = await client.describe();
  expect(screen.width).toBeGreaterThan(200);
  expect(screen.width).toBeLessThan(2000);       // points, not pixels
  expect(screen.height).toBeGreaterThan(screen.width);
});

test('video delivers H264 data within a few seconds', async () => {
  let bytes = 0;
  const h = client.startVideo((c) => { bytes += c.length; }, () => {});
  await new Promise((r) => setTimeout(r, 4000));
  h.stop();
  expect(bytes).toBeGreaterThan(10_000);
});

test('hid input is accepted and the accessibility tree is readable', async () => {
  const hid = client.openHid(() => {});
  hid.button('HOME');
  await new Promise((r) => setTimeout(r, 1500));
  hid.end();
  const tree = await client.accessibilityInfo();
  expect(tree.length).toBeGreaterThan(100);
});
```

- [ ] **Step 4: Run the live test**

Run: `mise x -- npm run test:live -- tests/live/idb-client.live.test.ts`
Expected: PASS (3 tests) with a booted simulator.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: typed idb gRPC client with live tests"
```

---

### Task 8: Session hub

**Files:**
- Create: `src/server/session/hub.ts`
- Test: `tests/hub.test.ts`

**Interfaces:**
- Consumes: `IdbClient`, `NaluSplitter`, `ControlArbiter`.
- Produces: `class SessionHub` with `static async open(client, udid)`, `screen`, `addViewer(v: Viewer): () => void`, `handle(clientId, msg): void`, `removeClient(clientId)`, `close()`.
- `Viewer = { id: string; name: string; sendVideo(nal: Uint8Array): void; send(msg: ServerMsg): void }`.
- On `addViewer`, cached SPS/PPS and the last keyframe are replayed immediately so a joiner paints without waiting for the next keyframe.

- [ ] **Step 1: Write the failing test `tests/hub.test.ts`**

This test drives the hub with a fake client so it needs no simulator.

```ts
import { SessionHub } from '../src/server/session/hub.js';
import type { ServerMsg } from '../src/shared/protocol.js';

function fakeClient() {
  const calls: string[] = [];
  let emit: (c: Buffer) => void = () => {};
  return {
    calls,
    pushNal: (b: Buffer) => emit(b),
    describe: async () => ({ screen: { width: 402, height: 874 }, name: 'Fake' }),
    openHid: () => ({
      touch: (p: string, x: number, y: number) => calls.push(`touch:${p}:${x},${y}`),
      button: (b: string) => calls.push(`button:${b}`),
      key: (c: number) => calls.push(`key:${c}`),
      pinch: () => calls.push('pinch'),
      orientation: (o: string) => calls.push(`orientation:${o}`),
      end: () => calls.push('end'),
    }),
    startVideo: (onNal: (c: Buffer) => void) => { emit = onNal; return { stop: () => calls.push('videostop') }; },
    close: () => {},
  };
}

function viewer(id: string) {
  const msgs: ServerMsg[] = []; const nals: Uint8Array[] = [];
  return { id, name: id, msgs, nals, send: (m: ServerMsg) => msgs.push(m), sendVideo: (n: Uint8Array) => nals.push(n) };
}

const sc = (...b: number[]) => Buffer.from([0, 0, 0, 1, ...b]);

test('first touch claims control and reaches the simulator', async () => {
  const c = fakeClient();
  const hub = await SessionHub.open(c as never, 'UDID');
  const a = viewer('alice'); hub.addViewer(a);
  hub.handle('alice', { type: 'touch', phase: 'down', x: 5, y: 6 });
  expect(c.calls).toContain('touch:down:5,6');
});

test('a second viewer is view-only and its input is dropped', async () => {
  const c = fakeClient();
  const hub = await SessionHub.open(c as never, 'UDID');
  hub.addViewer(viewer('alice')); const b = viewer('bob'); hub.addViewer(b);
  hub.handle('alice', { type: 'touch', phase: 'down', x: 1, y: 1 });
  c.calls.length = 0;
  hub.handle('bob', { type: 'touch', phase: 'down', x: 9, y: 9 });
  expect(c.calls).toEqual([]);
});

test('takeControl lifts the previous controller held finger', async () => {
  const c = fakeClient();
  const hub = await SessionHub.open(c as never, 'UDID');
  hub.addViewer(viewer('alice')); hub.addViewer(viewer('bob'));
  hub.handle('alice', { type: 'touch', phase: 'down', x: 3, y: 4 });
  c.calls.length = 0;
  hub.handle('bob', { type: 'takeControl' });
  expect(c.calls).toContain('touch:up:3,4');
});

test('a joining viewer immediately receives cached SPS/PPS and last keyframe', async () => {
  const c = fakeClient();
  const hub = await SessionHub.open(c as never, 'UDID');
  const early = viewer('early'); hub.addViewer(early);
  c.pushNal(sc(0x67, 0x42, 0xE0, 0x1E));   // SPS
  c.pushNal(sc(0x68, 0xCE));               // PPS
  c.pushNal(sc(0x65, 0xAA));               // IDR keyframe
  c.pushNal(sc(0x41, 0xBB));               // non-IDR
  c.pushNal(sc(0x41, 0xCC));               // flushes the previous unit

  const late = viewer('late'); hub.addViewer(late);
  const types = late.nals.map((n) => n[0]! & 0x1f);
  expect(types).toContain(7);
  expect(types).toContain(8);
  expect(types).toContain(5);
});

test('disconnecting the controller frees control', async () => {
  const c = fakeClient();
  const hub = await SessionHub.open(c as never, 'UDID');
  hub.addViewer(viewer('alice')); const b = viewer('bob'); hub.addViewer(b);
  hub.handle('alice', { type: 'touch', phase: 'down', x: 1, y: 1 });
  hub.removeClient('alice');
  hub.handle('bob', { type: 'touch', phase: 'down', x: 2, y: 2 });
  expect(c.calls).toContain('touch:down:2,2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise x -- npx vitest run tests/hub.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/session/hub.ts`**

```ts
import type { ClientMsg, ScreenPoints, ServerMsg } from '../../shared/protocol.js';
import type { HidStream, IdbClient, VideoHandle } from '../idb/client.js';
import { NaluSplitter, nalType, isKeyframe, NAL_SPS, NAL_PPS } from '../video/nalu.js';
import { ControlArbiter } from './arbiter.js';

export interface Viewer {
  id: string;
  name: string;
  send(msg: ServerMsg): void;
  sendVideo(nal: Uint8Array): void;
}

/** One per simulator: a single HID stream and a single video stream, fanned out. */
export class SessionHub {
  #viewers = new Map<string, Viewer>();
  #arbiter = new ControlArbiter();
  #splitter = new NaluSplitter();
  #sps: Uint8Array | null = null;
  #pps: Uint8Array | null = null;
  #lastKeyframe: Uint8Array | null = null;

  private constructor(
    private readonly client: IdbClient,
    readonly udid: string,
    readonly screen: ScreenPoints,
    private hid: HidStream,
    private video: VideoHandle | null,
  ) {}

  static async open(client: IdbClient, udid: string): Promise<SessionHub> {
    const { screen } = await client.describe();
    const hid = client.openHid((e) => console.error('[hid]', e.message));
    const hub = new SessionHub(client, udid, screen, hid, null);
    hub.video = client.startVideo((c) => hub.#onVideo(c), (e) => console.error('[video]', e.message));
    return hub;
  }

  #onVideo(chunk: Buffer): void {
    for (const nal of this.#splitter.push(new Uint8Array(chunk))) {
      const t = nalType(nal);
      if (t === NAL_SPS) this.#sps = nal;
      else if (t === NAL_PPS) this.#pps = nal;
      else if (isKeyframe(nal)) this.#lastKeyframe = nal;
      for (const v of this.#viewers.values()) v.sendVideo(nal);
    }
  }

  addViewer(v: Viewer): () => void {
    this.#viewers.set(v.id, v);
    v.send({ type: 'hello', udid: this.udid, clientId: v.id, name: v.name, screen: this.screen });
    // Replay decoder init so the joiner paints without waiting for a keyframe.
    if (this.#sps) v.sendVideo(this.#sps);
    if (this.#pps) v.sendVideo(this.#pps);
    if (this.#lastKeyframe) v.sendVideo(this.#lastKeyframe);
    this.#broadcastControl();
    return () => this.removeClient(v.id);
  }

  removeClient(id: string): void {
    const handover = this.#arbiter.release(id);
    if (handover.synthesizeUp) this.hid.touch('up', handover.synthesizeUp.x, handover.synthesizeUp.y);
    this.#viewers.delete(id);
    if (handover.previous) this.#broadcastControl();
  }

  handle(clientId: string, msg: ClientMsg): void {
    if (msg.type === 'setName') {
      const v = this.#viewers.get(clientId);
      if (v) { v.name = msg.name; this.#broadcastControl(); }
      return;
    }

    if (msg.type === 'takeControl') {
      const h = this.#arbiter.takeControl(clientId);
      if (h.synthesizeUp) this.hid.touch('up', h.synthesizeUp.x, h.synthesizeUp.y);
      if (h.previous && h.previous !== clientId) {
        this.#viewers.get(h.previous)?.send({
          type: 'toast', text: `${this.#viewers.get(clientId)?.name ?? 'Someone'} took control`,
        });
      }
      this.#broadcastControl();
      return;
    }

    // Claim-by-interaction: when control is free, acting on it takes it.
    if (this.#arbiter.controller === null) {
      if (this.#arbiter.claimIfFree(clientId)) this.#broadcastControl();
    }
    if (!this.#arbiter.canAccept(clientId)) return;

    switch (msg.type) {
      case 'touch':
        this.#arbiter.noteTouch(clientId, msg.phase, msg.x, msg.y);
        this.hid.touch(msg.phase, msg.x, msg.y);
        break;
      case 'button': this.hid.button(msg.button); break;
      case 'key': this.hid.key(msg.keycode); break;
      case 'text': for (const ch of msg.text) this.hid.key(ch.charCodeAt(0)); break;
      case 'orientation': this.hid.orientation(msg.orientation); break;
      case 'pinch': this.hid.pinch(msg.x, msg.y, msg.scale, msg.duration); break;
    }
  }

  #broadcastControl(): void {
    const id = this.#arbiter.controller;
    const msg: ServerMsg = {
      type: 'control',
      controllerId: id,
      controllerName: id ? this.#viewers.get(id)?.name ?? null : null,
    };
    for (const v of this.#viewers.values()) v.send(msg);
  }

  close(): void {
    this.video?.stop();
    this.hid.end();
    this.client.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `mise x -- npx vitest run tests/hub.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: session hub with video fan-out and control routing"
```

---

### Task 9: HTTP and WebSocket server with auth

**Files:**
- Create: `src/server/auth.ts`, `src/server/config.ts`, `src/server/index.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Produces: `parseArgs(argv): Config` where `Config = { host: string; port: number; auth: boolean; token: string }`; `sessionCookie(token)`, `checkAuth(req, cfg)`.
- Routes: `GET /` (app), `GET /api/sims` (booted list), `WS /ws/:udid` (control), `WS /video/:udid` (binary NALs).
- Token arrives as `?token=`, is exchanged for an `HttpOnly` cookie, and both WS upgrades reject unauthenticated requests.

- [ ] **Step 1: Write the failing test `tests/auth.test.ts`**

```ts
import { parseArgs, checkAuth, COOKIE } from '../src/server/auth.js';

const cfg = { host: '0.0.0.0', port: 8080, auth: true, token: 'secret' };

test('defaults: auth on, LAN bind, generated token', () => {
  const c = parseArgs([]);
  expect(c.auth).toBe(true);
  expect(c.host).toBe('0.0.0.0');
  expect(c.token.length).toBeGreaterThan(8);
});

test('--no-auth disables auth and --port/--host are honoured', () => {
  const c = parseArgs(['--no-auth', '--port', '9999', '--host', '127.0.0.1']);
  expect(c.auth).toBe(false);
  expect(c.port).toBe(9999);
  expect(c.host).toBe('127.0.0.1');
});

test('accepts a correct query token', () => {
  expect(checkAuth({ url: '/?token=secret', headers: {} }, cfg)).toBe(true);
});

test('accepts a valid session cookie', () => {
  expect(checkAuth({ url: '/', headers: { cookie: `${COOKIE}=secret` } }, cfg)).toBe(true);
});

test('rejects a wrong or missing token', () => {
  expect(checkAuth({ url: '/?token=nope', headers: {} }, cfg)).toBe(false);
  expect(checkAuth({ url: '/', headers: {} }, cfg)).toBe(false);
});

test('allows everything when auth is disabled', () => {
  expect(checkAuth({ url: '/', headers: {} }, { ...cfg, auth: false })).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise x -- npx vitest run tests/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/auth.ts`**

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'sim_remote_session';

export interface Config { host: string; port: number; auth: boolean; token: string }

export function parseArgs(argv: string[]): Config {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    host: get('--host') ?? '0.0.0.0',
    port: Number(get('--port') ?? 8080),
    auth: !argv.includes('--no-auth'),
    token: get('--token') ?? randomBytes(16).toString('hex'),
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface AuthableRequest { url?: string; headers: { cookie?: string } }

export function checkAuth(req: AuthableRequest, cfg: Config): boolean {
  if (!cfg.auth) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams.get('token');
  if (q && safeEqual(q, cfg.token)) return true;
  const cookie = req.headers.cookie ?? '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie);
  return m ? safeEqual(m[1]!, cfg.token) : false;
}
```

- [ ] **Step 4: Write `src/server/index.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { checkAuth, parseArgs, COOKIE } from './auth.js';
import { listBootedSims } from './companion/discovery.js';
import { CompanionSupervisor } from './companion/supervisor.js';
import { IdbClient } from './idb/client.js';
import { SessionHub, type Viewer } from './session/hub.js';
import { isClientMsg, type ServerMsg } from '../shared/protocol.js';

const cfg = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(here, '../../dist/client');

const supervisor = new CompanionSupervisor();
const hubs = new Map<string, Promise<SessionHub>>();
let guestSeq = 0;

function hubFor(udid: string): Promise<SessionHub> {
  let h = hubs.get(udid);
  if (!h) {
    h = (async () => SessionHub.open(IdbClient.connect(await supervisor.socketFor(udid)), udid))();
    hubs.set(udid, h);
    h.catch(() => hubs.delete(udid));
  }
  return h;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon',
};

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuth(req, cfg)) { res.writeHead(401).end('unauthorized'); return; }

  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.searchParams.has('token') && cfg.auth) {
    res.setHeader('Set-Cookie', `${COOKIE}=${cfg.token}; HttpOnly; SameSite=Strict; Path=/`);
    if (url.pathname === '/') { res.writeHead(302, { Location: '/' }).end(); return; }
  }

  if (url.pathname === '/api/sims') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await listBootedSims()));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  try {
    const body = await readFile(join(CLIENT_DIR, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer((req, res) => { void onRequest(req, res); });
const controlWss = new WebSocketServer({ noServer: true });
const videoWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req, cfg)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const control = /^\/ws\/(.+)$/.exec(url.pathname);
  const video = /^\/video\/(.+)$/.exec(url.pathname);
  if (control) controlWss.handleUpgrade(req, socket, head, (ws) => void onControl(ws, control[1]!, url));
  else if (video) videoWss.handleUpgrade(req, socket, head, (ws) => void onVideo(ws, video[1]!, url));
  else { socket.destroy(); }
});

/** Video and control share a clientId so the hub treats them as one viewer. */
const pendingVideo = new Map<string, WebSocket>();

async function onControl(ws: WebSocket, udid: string, url: URL): Promise<void> {
  const clientId = url.searchParams.get('cid') ?? randomUUID();
  const name = url.searchParams.get('name') ?? `Guest ${++guestSeq}`;
  let hub: SessionHub;
  try { hub = await hubFor(udid); }
  catch (e) {
    ws.send(JSON.stringify({ type: 'status', state: 'simulator-gone' } satisfies ServerMsg));
    ws.close(); return;
  }

  const viewer: Viewer = {
    id: clientId, name,
    send: (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
    sendVideo: (nal) => {
      const vs = pendingVideo.get(clientId);
      if (vs && vs.readyState === vs.OPEN && vs.bufferedAmount < 4_000_000) vs.send(nal);
    },
  };
  hub.addViewer(viewer);

  ws.on('message', (data) => {
    let parsed: unknown;
    try { parsed = JSON.parse(String(data)); } catch { return; }
    if (isClientMsg(parsed)) hub.handle(clientId, parsed);
  });
  ws.on('close', () => { hub.removeClient(clientId); pendingVideo.delete(clientId); });
}

async function onVideo(ws: WebSocket, _udid: string, url: URL): Promise<void> {
  const cid = url.searchParams.get('cid');
  if (!cid) { ws.close(); return; }
  ws.binaryType = 'nodebuffer';
  pendingVideo.set(cid, ws);
  ws.on('close', () => { if (pendingVideo.get(cid) === ws) pendingVideo.delete(cid); });
}

server.listen(cfg.port, cfg.host, () => {
  const suffix = cfg.auth ? `/?token=${cfg.token}` : '/';
  console.log(`sim-remote listening on http://${cfg.host}:${cfg.port}${suffix}`);
  if (!cfg.auth) console.warn('WARNING: auth disabled — anyone on this network can drive the simulator');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const h of hubs.values()) void h.then((x) => x.close()).catch(() => {});
    supervisor.stopAll();
    process.exit(0);
  });
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `mise x -- npx vitest run tests/auth.test.ts && mise x -- npm run typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: http/ws server with token auth and video fan-out"
```

---

### Task 10: Browser client

**Files:**
- Create: `src/client/index.html`, `src/client/decoder.ts`, `src/client/ui.ts`, `src/client/main.ts`
- Create: `vite.config.ts`

**Interfaces:**
- Consumes: `GestureRecognizer`, `ClientMsg`/`ServerMsg`, `codecStringFromSps`.
- Produces: a page that picks a booted simulator, renders video to a canvas, sends input, and shows the control badge.

- [ ] **Step 1: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
export default defineConfig({
  root: 'src/client',
  build: { outDir: '../../dist/client', emptyOutDir: true },
});
```

- [ ] **Step 2: Write `src/client/decoder.ts`**

```ts
import { codecStringFromSps, nalType, isKeyframe, NAL_SPS, NAL_PPS } from '../server/video/nalu.js';

/**
 * Feeds Annex-B NAL units into a WebCodecs VideoDecoder.
 * Configuration waits for an SPS; decoding waits for the first keyframe.
 */
export class H264Player {
  #decoder: VideoDecoder | null = null;
  #configured = false;
  #sawKeyframe = false;
  #sps: Uint8Array | null = null;
  #pps: Uint8Array | null = null;
  #ts = 0;

  constructor(private readonly onFrame: (f: VideoFrame) => void, private readonly onError: (m: string) => void) {}

  static supported(): boolean { return typeof VideoDecoder !== 'undefined'; }

  push(nal: Uint8Array): void {
    const t = nalType(nal);
    if (t === NAL_SPS) { this.#sps = nal; this.#configure(); return; }
    if (t === NAL_PPS) { this.#pps = nal; return; }
    if (!this.#configured) return;
    if (!this.#sawKeyframe && !isKeyframe(nal)) return;   // wait for a clean start

    const key = isKeyframe(nal);
    if (key) this.#sawKeyframe = true;

    // Prepend SPS/PPS to each keyframe so recovery never needs a new stream.
    const parts = key && this.#sps && this.#pps ? [this.#sps, this.#pps, nal] : [nal];
    const data = this.#annexB(parts);
    try {
      this.#decoder!.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta', timestamp: this.#ts, data,
      }));
      this.#ts += 33_333;
    } catch (e) { this.#recover(); }
  }

  #annexB(units: Uint8Array[]): Uint8Array {
    const total = units.reduce((n, u) => n + 4 + u.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const u of units) { out.set([0, 0, 0, 1], o); o += 4; out.set(u, o); o += u.length; }
    return out;
  }

  #configure(): void {
    if (this.#configured || !this.#sps) return;
    if (!H264Player.supported()) { this.onError('This browser has no WebCodecs support. Use Chrome, Edge, Firefox 130+, or Safari 16.4+.'); return; }
    this.#decoder = new VideoDecoder({
      output: (f) => this.onFrame(f),
      error: () => this.#recover(),
    });
    this.#decoder.configure({ codec: codecStringFromSps(this.#sps), optimizeForLatency: true });
    this.#configured = true;
  }

  /** On decode error, drop everything until the next keyframe. */
  #recover(): void { this.#sawKeyframe = false; }

  close(): void { try { this.#decoder?.close(); } catch { /* already closed */ } }
}
```

- [ ] **Step 3: Write `src/client/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>sim-remote</title>
  <style>
    :root { color-scheme: light dark; --bg:#111; --fg:#eee; --accent:#3b82f6; }
    body { margin:0; background:var(--bg); color:var(--fg);
           font:14px/1.4 system-ui,sans-serif; display:flex; flex-direction:column;
           align-items:center; gap:12px; padding:16px; }
    header { display:flex; gap:12px; align-items:center; flex-wrap:wrap; justify-content:center; }
    #screen { background:#000; border-radius:28px; touch-action:none; max-height:80vh;
              box-shadow:0 8px 40px rgba(0,0,0,.5); }
    #screen.viewonly { cursor:not-allowed; }
    .btn { background:#222; color:var(--fg); border:1px solid #444; border-radius:8px;
           padding:6px 12px; cursor:pointer; }
    .btn:hover { border-color:var(--accent); }
    #badge { padding:4px 10px; border-radius:999px; background:#222; }
    #badge.driving { background:var(--accent); color:#fff; }
    #toast { position:fixed; bottom:20px; background:#222; padding:10px 16px;
             border-radius:8px; opacity:0; transition:opacity .3s; }
    #toast.show { opacity:1; }
  </style>
</head>
<body>
  <header>
    <select id="sims" class="btn"></select>
    <span id="badge">connecting…</span>
    <button id="take" class="btn" hidden>Take control</button>
    <button class="btn" data-button="HOME">Home</button>
    <button class="btn" data-button="LOCK">Lock</button>
    <button class="btn" data-button="SIRI">Siri</button>
    <button class="btn" data-rotate="LANDSCAPE_LEFT">Rotate</button>
  </header>
  <canvas id="screen"></canvas>
  <div id="toast"></div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

- [ ] **Step 4: Write `src/client/ui.ts`**

```ts
export function toast(text: string): void {
  const el = document.getElementById('toast')!;
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

export function setBadge(text: string, driving: boolean): void {
  const el = document.getElementById('badge')!;
  el.textContent = text;
  el.classList.toggle('driving', driving);
}
```

- [ ] **Step 5: Write `src/client/main.ts`**

```ts
import { GestureRecognizer } from './gestures.js';
import { H264Player } from './decoder.js';
import { setBadge, toast } from './ui.js';
import type { ClientMsg, ScreenPoints, ServerMsg, Orientation, HardwareButton } from '../shared/protocol.js';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const simsEl = document.getElementById('sims') as HTMLSelectElement;
const takeBtn = document.getElementById('take') as HTMLButtonElement;

const clientId = crypto.randomUUID();
let ws: WebSocket | null = null;
let screen: ScreenPoints = { width: 402, height: 874 };
let recognizer: GestureRecognizer | null = null;
let player: H264Player | null = null;
let controlling = false;

const send = (m: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const sendAll = (ms: ClientMsg[]) => ms.forEach(send);

async function loadSims(): Promise<void> {
  const sims: Array<{ udid: string; name: string; runtime: string }> = await (await fetch('/api/sims')).json();
  simsEl.innerHTML = '';
  for (const s of sims) {
    const o = document.createElement('option');
    o.value = s.udid; o.textContent = `${s.name} — ${s.runtime}`;
    simsEl.append(o);
  }
  if (sims.length === 0) { setBadge('no booted simulators', false); return; }
  connect(simsEl.value);
}

function connect(udid: string): void {
  ws?.close();
  player?.close();

  const videoWs = new WebSocket(`ws://${location.host}/video/${udid}?cid=${clientId}`);
  videoWs.binaryType = 'arraybuffer';

  player = new H264Player(
    (frame) => {
      if (canvas.width !== frame.displayWidth) {
        canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();
    },
    (m) => setBadge(m, false),
  );
  videoWs.onmessage = (e) => player!.push(new Uint8Array(e.data as ArrayBuffer));

  ws = new WebSocket(`ws://${location.host}/ws/${udid}?cid=${clientId}`);
  ws.onmessage = (e) => onServerMsg(JSON.parse(e.data as string) as ServerMsg);
  ws.onclose = () => setBadge('disconnected — retrying', false);
  ws.onerror = () => setBadge('connection error', false);
}

function onServerMsg(m: ServerMsg): void {
  switch (m.type) {
    case 'hello':
      screen = m.screen;
      canvas.style.aspectRatio = `${screen.width} / ${screen.height}`;
      recognizer = new GestureRecognizer(screen, () => canvas.getBoundingClientRect());
      break;
    case 'control': {
      controlling = m.controllerId === clientId;
      canvas.classList.toggle('viewonly', !controlling && m.controllerId !== null);
      takeBtn.hidden = controlling || m.controllerId === null;
      setBadge(controlling ? 'You are driving' : m.controllerName ? `${m.controllerName} is driving` : 'nobody driving — touch to take over', controlling);
      break;
    }
    case 'toast': toast(m.text); break;
    case 'status': if (m.state === 'simulator-gone') setBadge('simulator is gone', false); break;
  }
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  sendAll(recognizer?.pointerDown(e) ?? []);
});
canvas.addEventListener('pointermove', (e) => {
  const evs = e.getCoalescedEvents?.() ?? [e];
  for (const ce of evs) sendAll(recognizer?.pointerMove({ clientX: ce.clientX, clientY: ce.clientY, pointerId: e.pointerId }) ?? []);
});
const up = (e: PointerEvent) => sendAll(recognizer?.pointerUp(e) ?? []);
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
canvas.addEventListener('wheel', (e) => {
  if (e.ctrlKey) { e.preventDefault(); sendAll(recognizer?.wheel(e) ?? []); }
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'SELECT') return;
  if (e.key.length === 1) { send({ type: 'text', text: e.key }); e.preventDefault(); }
  else if (e.key === 'Backspace') { send({ type: 'key', keycode: 42 }); e.preventDefault(); }
  else if (e.key === 'Enter') { send({ type: 'key', keycode: 40 }); e.preventDefault(); }
});

takeBtn.addEventListener('click', () => send({ type: 'takeControl' }));
simsEl.addEventListener('change', () => connect(simsEl.value));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-button]')) {
  b.addEventListener('click', () => send({ type: 'button', button: b.dataset.button as HardwareButton }));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-rotate]')) {
  b.addEventListener('click', () => send({ type: 'orientation', orientation: b.dataset.rotate as Orientation }));
}

void loadSims();
```

- [ ] **Step 6: Build and typecheck**

Run: `mise x -- npm run build:client && mise x -- npm run typecheck`
Expected: build succeeds, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: browser client with WebCodecs H264 playback"
```

---

### Task 11: End-to-end verification and README

**Files:**
- Create: `tests/live/e2e.live.test.ts`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Asserts behaviour through the accessibility tree, not image diffs. Screenshot hashing is unreliable here: springboard gestures animate and settle back to an identical screen, which silently produced false negatives during design.

- [ ] **Step 1: Write `tests/live/e2e.live.test.ts`**

```ts
import { CompanionSupervisor } from '../../src/server/companion/supervisor.js';
import { listBootedSims } from '../../src/server/companion/discovery.js';
import { IdbClient } from '../../src/server/idb/client.js';
import { SessionHub, type Viewer } from '../../src/server/session/hub.js';
import type { ServerMsg } from '../../src/shared/protocol.js';

let sup: CompanionSupervisor; let hub: SessionHub;

function viewer(id: string): Viewer & { msgs: ServerMsg[]; bytes: number } {
  const v = { id, name: id, msgs: [] as ServerMsg[], bytes: 0,
    send(m: ServerMsg) { v.msgs.push(m); },
    sendVideo(n: Uint8Array) { v.bytes += n.length; } };
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const sims = await listBootedSims();
  if (sims.length === 0) throw new Error('live tests need a booted simulator');
  sup = new CompanionSupervisor();
  hub = await SessionHub.open(IdbClient.connect(await sup.socketFor(sims[0]!.udid)), sims[0]!.udid);
}, 120_000);
afterAll(() => { hub?.close(); sup?.stopAll(); });

test('screen is reported in points, not pixels', () => {
  expect(hub.screen.width).toBeLessThan(1000);
});

test('video reaches a viewer', async () => {
  const v = viewer('v1'); hub.addViewer(v);
  await sleep(4000);
  expect(v.bytes).toBeGreaterThan(10_000);
  hub.removeClient('v1');
});

test('a streamed drag scrolls a scrollable list', async () => {
  const v = viewer('driver'); hub.addViewer(v);
  hub.handle('driver', { type: 'button', button: 'HOME' });
  await sleep(2000);

  const before = await hubTreeOffsets();
  const { width, height } = hub.screen;
  const x = Math.round(width / 2);
  hub.handle('driver', { type: 'touch', phase: 'down', x, y: Math.round(height * 0.75) });
  for (let i = 1; i <= 30; i++) {
    hub.handle('driver', { type: 'touch', phase: 'move', x, y: Math.round(height * 0.75 - i * (height * 0.012)) });
    await sleep(12);
  }
  hub.handle('driver', { type: 'touch', phase: 'up', x, y: Math.round(height * 0.39) });
  await sleep(2500);

  const after = await hubTreeOffsets();
  expect(after).not.toEqual(before);
  hub.removeClient('driver');
});

// Reads the accessibility tree through the hub's client for a stable assertion.
async function hubTreeOffsets(): Promise<string> {
  const tree = await (hub as unknown as { client: IdbClient }).client.accessibilityInfo();
  return tree.slice(0, 400);
}
```

- [ ] **Step 2: Run live tests**

Run: `mise x -- npm run test:live`
Expected: PASS with a booted simulator.

- [ ] **Step 3: Write `README.md`**

Must document: prerequisites (`brew tap facebook/fb && brew install idb-companion`, Xcode 26+, a booted simulator), `npm install`, `npm run build:client`, `npm run dev`, the printed tokenised URL, `--no-auth`/`--host`/`--port`, the one-controller model, and the WebCodecs browser requirement.

- [ ] **Step 4: Run the whole suite**

Run: `mise x -- npm test && mise x -- npm run typecheck`
Expected: all unit tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: end-to-end live tests and README"
```

---

## Self-Review Notes

**Spec coverage:** companion supervision (T6), gRPC client (T7), video fan-out with keyframe replay (T8), single-controller arbiter with stuck-finger safety (T4, T8), gesture mapping incl. pinch/keyboard/buttons/rotation (T5, T9, T10), point-space coordinates (T2), NAL parsing and codec string (T3), token auth (T9), slow-viewer backpressure (T9, `bufferedAmount` guard), WebCodecs error path (T10), AX-based integration tests (T7, T11).

**Deferred from the spec, intentionally:** companion auto-restart is limited to respawn-on-next-request rather than eager restart with client notification; `status: 'reconnecting'` is sent by the client on socket close rather than driven by supervisor health events. Both are visible in the UI and neither blocks the milestone goals.
