/**
 * Character -> USB HID Keyboard/Keypad usage code (page 0x07).
 *
 * idb's HIDKey.keycode is a HID *usage* code, NOT an ASCII code point. Sending
 * 'a'.charCodeAt(0) (97) types Keypad 9, not 'a'.
 */

export const HID_LEFT_SHIFT = 225;

export interface HidKey { code: number; shift: boolean }

const A = 'a'.charCodeAt(0);
const Z = 'z'.charCodeAt(0);

/** Unshifted punctuation -> usage code. */
const PUNCT: Record<string, number> = {
  '-': 45, '=': 46, '[': 47, ']': 48, '\\': 49, ';': 51,
  "'": 52, '`': 53, ',': 54, '.': 55, '/': 56,
};

/** Shifted character -> the unshifted key it lives on. */
const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '~': '`', '<': ',', '>': '.', '?': '/',
};

function unshiftedCode(ch: string): number | null {
  const c = ch.charCodeAt(0);
  if (c >= A && c <= Z) return 4 + (c - A);
  if (ch >= '1' && ch <= '9') return 30 + (c - '1'.charCodeAt(0));
  if (ch === '0') return 39;
  if (ch === ' ') return 44;
  return PUNCT[ch] ?? null;
}

/** Returns null for characters with no US-keyboard key, rather than a wrong one. */
export function charToHid(ch: string): HidKey | null {
  if (ch.length !== 1) return null;

  const lower = ch.toLowerCase();
  if (lower !== ch && lower.length === 1) {
    const code = unshiftedCode(lower);
    return code === null ? null : { code, shift: true };
  }

  const base = SHIFTED[ch];
  if (base !== undefined) {
    const code = unshiftedCode(base);
    return code === null ? null : { code, shift: true };
  }

  const code = unshiftedCode(ch);
  return code === null ? null : { code, shift: false };
}
