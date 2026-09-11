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

test('a second pointer does not start a competing gesture', () => {
  const g = mk();
  g.pointerDown(p(100, 200, 1));
  expect(g.pointerDown(p(300, 400, 2))).toEqual([]);
  expect(g.pointerUp(p(300, 400, 2))).toEqual([]);
  expect(g.pointerUp(p(100, 200, 1))).toEqual([{ type: 'touch', phase: 'up', x: 100, y: 200 }]);
});

test('after an up a new gesture can start', () => {
  const g = mk();
  g.pointerDown(p(10, 10));
  g.pointerUp(p(10, 10));
  expect(g.pointerDown(p(20, 20))).toEqual([{ type: 'touch', phase: 'down', x: 20, y: 20 }]);
});

test('ctrl+wheel becomes a pinch centred on the cursor', () => {
  const g = mk();
  const out = g.wheel({ clientX: 201, clientY: 437, deltaY: -100, ctrlKey: true });
  expect(out.length).toBe(1);
  const m = out[0]!;
  if (m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.x).toBe(201);
  expect(m.y).toBe(437);
  expect(m.scale).toBeGreaterThan(1);
});

test('positive wheel delta zooms out', () => {
  const g = mk();
  const m = g.wheel({ clientX: 201, clientY: 437, deltaY: 100, ctrlKey: true })[0]!;
  if (m.type !== 'pinch') throw new Error('expected pinch');
  expect(m.scale).toBeLessThan(1);
});

test('plain wheel without ctrl is not a pinch', () => {
  expect(mk().wheel({ clientX: 10, clientY: 10, deltaY: -100, ctrlKey: false })).toEqual([]);
});
