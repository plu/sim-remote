import { charToHid, HID_LEFT_SHIFT } from '../src/shared/keymap.ts';

test('lowercase letters map to usage codes 4..29', () => {
  expect(charToHid('a')).toEqual({ code: 4, shift: false });
  expect(charToHid('z')).toEqual({ code: 29, shift: false });
});

test('uppercase letters use the same code with shift', () => {
  expect(charToHid('A')).toEqual({ code: 4, shift: true });
  expect(charToHid('Z')).toEqual({ code: 29, shift: true });
});

test('digits map 1..9 to 30..38 and 0 to 39', () => {
  expect(charToHid('1')).toEqual({ code: 30, shift: false });
  expect(charToHid('9')).toEqual({ code: 38, shift: false });
  expect(charToHid('0')).toEqual({ code: 39, shift: false });
});

test('space is usage 44', () => {
  expect(charToHid(' ')).toEqual({ code: 44, shift: false });
});

test('unshifted punctuation', () => {
  expect(charToHid('-')).toEqual({ code: 45, shift: false });
  expect(charToHid('.')).toEqual({ code: 55, shift: false });
  expect(charToHid('/')).toEqual({ code: 56, shift: false });
});

test('shifted punctuation reuses the base key with shift', () => {
  expect(charToHid('!')).toEqual({ code: 30, shift: true });   // shift+1
  expect(charToHid('?')).toEqual({ code: 56, shift: true });   // shift+/
  expect(charToHid(':')).toEqual({ code: 51, shift: true });   // shift+;
  expect(charToHid('_')).toEqual({ code: 45, shift: true });   // shift+-
});

test('ASCII code points are NOT used as usage codes', () => {
  // The original bug: 'a'.charCodeAt(0) === 97, which is Keypad 9.
  expect(charToHid('a')!.code).not.toBe('a'.charCodeAt(0));
});

test('unmappable characters return null rather than a wrong key', () => {
  expect(charToHid('é')).toBeNull();
  expect(charToHid('😀')).toBeNull();
});

test('left shift usage code is 225', () => {
  expect(HID_LEFT_SHIFT).toBe(225);
});
