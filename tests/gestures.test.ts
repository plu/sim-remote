import { GestureRecognizer } from '../src/client/gestures.ts';

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

test('a third pointer does not disturb an in-progress pinch', () => {
  const g = mk();
  g.pointerDown(p(180, 400, 1));
  g.pointerDown(p(220, 400, 2));
  expect(g.pointerDown(p(300, 700, 3))).toEqual([]);
  expect(g.pointerMove(p(300, 700, 3))).toEqual([]);
});

test('after an up a new gesture can start', () => {
  const g = mk();
  g.pointerDown(p(10, 10));
  g.pointerUp(p(10, 10));
  expect(g.pointerDown(p(20, 20))).toEqual([{ type: 'touch', phase: 'down', x: 20, y: 20 }]);
});

test('ctrl+wheel yields a pinch centred on the cursor, once taken', () => {
  const g = mk();
  expect(g.wheel({ clientX: 201, clientY: 437, deltaY: -100, ctrlKey: true })).toEqual([]);
  const m = g.takePinch();
  if (!m || m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.x).toBe(201);
  expect(m.y).toBe(437);
  expect(m.scale).toBeGreaterThan(1);
});

test('positive wheel delta zooms out', () => {
  const g = mk();
  g.wheel({ clientX: 201, clientY: 437, deltaY: 100, ctrlKey: true });
  const m = g.takePinch();
  if (!m || m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.scale).toBeLessThan(1);
});

test('plain wheel without ctrl is not a pinch', () => {
  expect(mk().wheel({ clientX: 10, clientY: 10, deltaY: -100, ctrlKey: false })).toEqual([]);
});

// --- pinch ---

test('wheel ticks accumulate instead of firing a gesture each', () => {
  const g = mk();
  expect(g.wheel({ clientX: 201, clientY: 437, deltaY: -50, ctrlKey: true })).toEqual([]);
  expect(g.wheel({ clientX: 201, clientY: 437, deltaY: -50, ctrlKey: true })).toEqual([]);
  const m = g.takePinch();
  if (!m || m.type !== 'pinch') throw new Error('expected a pending pinch');
  // Two -50 ticks compose to the same scale as one -100 tick.
  expect(m.scale).toBeCloseTo(Math.exp(100 / 100), 5);
});

test('takePinch clears the pending gesture', () => {
  const g = mk();
  g.wheel({ clientX: 10, clientY: 10, deltaY: -50, ctrlKey: true });
  expect(g.takePinch()).not.toBeNull();
  expect(g.takePinch()).toBeNull();
});

test('takePinch is null when nothing is pending', () => {
  expect(mk().takePinch()).toBeNull();
});

test('a second finger lifts the in-progress single-touch gesture', () => {
  const g = mk();
  expect(g.pointerDown(p(100, 400, 1))).toEqual([{ type: 'touch', phase: 'down', x: 100, y: 400 }]);
  // The held finger must be released, or the simulator stays mid-drag.
  expect(g.pointerDown(p(300, 400, 2))).toEqual([{ type: 'touch', phase: 'up', x: 100, y: 400 }]);
});

test('spreading two fingers emits a zoom-in pinch on release', () => {
  const g = mk();
  g.pointerDown(p(180, 400, 1));
  g.pointerDown(p(220, 400, 2));          // initial separation 40
  g.pointerMove(p(140, 400, 1));
  g.pointerMove(p(260, 400, 2));          // separation now 120
  const out = g.pointerUp(p(140, 400, 1));
  expect(out.length).toBe(1);
  const m = out[0]!;
  if (m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.scale).toBeCloseTo(3, 1);      // 120 / 40
  expect(m.x).toBe(200);                  // midpoint
  expect(m.y).toBe(400);
});

test('bringing two fingers together emits a zoom-out pinch', () => {
  const g = mk();
  g.pointerDown(p(140, 400, 1));
  g.pointerDown(p(260, 400, 2));          // separation 120
  g.pointerMove(p(190, 400, 1));
  g.pointerMove(p(210, 400, 2));          // separation 20
  const m = g.pointerUp(p(190, 400, 1))[0]!;
  if (m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.scale).toBeLessThan(1);
});

test('a two-finger gesture emits no touch events while pinching', () => {
  const g = mk();
  g.pointerDown(p(180, 400, 1));
  g.pointerDown(p(220, 400, 2));
  expect(g.pointerMove(p(140, 400, 1))).toEqual([]);
  expect(g.pointerMove(p(260, 400, 2))).toEqual([]);
});

test('after a pinch completes a new single touch works again', () => {
  const g = mk();
  g.pointerDown(p(180, 400, 1));
  g.pointerDown(p(220, 400, 2));
  g.pointerUp(p(180, 400, 1));
  g.pointerUp(p(220, 400, 2));
  expect(g.pointerDown(p(50, 50, 3))).toEqual([{ type: 'touch', phase: 'down', x: 50, y: 50 }]);
});

test('pinch radius never drops below the recogniser threshold', () => {
  const g = mk();
  g.pointerDown(p(199, 400, 1));
  g.pointerDown(p(203, 400, 2));      // fingers almost touching
  g.pointerMove(p(150, 400, 1));
  g.pointerMove(p(250, 400, 2));
  const m = g.pointerUp(p(150, 400, 1))[0]!;
  if (m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.radius).toBeGreaterThanOrEqual(40);
});

test('pinch radius follows the fingers when they start far apart', () => {
  const g = mk();
  g.pointerDown(p(100, 400, 1));
  g.pointerDown(p(300, 400, 2));      // 200 apart
  g.pointerMove(p(50, 400, 1));
  g.pointerMove(p(350, 400, 2));
  const m = g.pointerUp(p(50, 400, 1))[0]!;
  if (m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.radius).toBe(100);
});
