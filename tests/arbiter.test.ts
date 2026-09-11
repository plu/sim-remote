import { ControlArbiter } from '../src/server/session/arbiter.ts';

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

test('a non-controller cannot poison the held-finger state', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  a.noteTouch('bob', 'down', 99, 99);
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

test('taking control you already hold is a no-op', () => {
  const a = new ControlArbiter();
  a.claimIfFree('alice');
  a.noteTouch('alice', 'down', 1, 2);
  const r = a.takeControl('alice');
  expect(r.synthesizeUp).toBeNull();
  expect(a.controller).toBe('alice');
});
