import { isClientMsg } from '../src/shared/protocol.ts';

test('accepts a touch message', () => {
  expect(isClientMsg({ type: 'touch', phase: 'down', x: 1, y: 2 })).toBe(true);
});

test('rejects unknown and malformed input', () => {
  expect(isClientMsg({ type: 'nope' })).toBe(false);
  expect(isClientMsg(null)).toBe(false);
  expect(isClientMsg('touch')).toBe(false);
});
