import { pixelsToPoints, canvasToPoint } from '../src/shared/coords.ts';

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
  expect(canvasToPoint(100.5, 218.5, small, screen)).toEqual({ x: 201, y: 437 });
});

test('accounts for rect offset', () => {
  const offset = { left: 50, top: 20, width: 402, height: 874 };
  expect(canvasToPoint(60, 30, offset, screen)).toEqual({ x: 10, y: 10 });
});

test('clamps out-of-bounds positions into the screen', () => {
  expect(canvasToPoint(-30, 99999, rect, screen)).toEqual({ x: 0, y: 874 });
});
