import {
  NaluSplitter, nalType, isKeyframe, codecStringFromSps, NAL_SPS, NAL_IDR,
} from '../src/server/video/nalu.ts';

const sc4 = [0, 0, 0, 1];
const sc3 = [0, 0, 1];
const u8 = (...n: number[]) => new Uint8Array(n);

test('nalType reads the low 5 bits of the header byte', () => {
  expect(nalType(u8(0x67, 0x42))).toBe(NAL_SPS);
  expect(nalType(u8(0x65, 0x88))).toBe(NAL_IDR);
});

test('isKeyframe is true only for IDR', () => {
  expect(isKeyframe(u8(0x65))).toBe(true);
  expect(isKeyframe(u8(0x41))).toBe(false);
});

test('splits multiple NAL units in one chunk, stripping start codes', () => {
  const s = new NaluSplitter();
  const out = s.push(u8(...sc4, 0x67, 0xAA, ...sc3, 0x68, 0xBB));
  expect(out.length).toBe(1);
  expect(Array.from(out[0]!)).toEqual([0x67, 0xAA]);
});

test('reassembles a NAL unit split across chunk boundaries', () => {
  const s = new NaluSplitter();
  expect(s.push(u8(...sc4, 0x67, 0xAA)).length).toBe(0);
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
  expect(out.length).toBe(1);
  expect(Array.from(out[0]!)).toEqual([0x67, 0x01]);
});

test('flush emits the final held unit', () => {
  const s = new NaluSplitter();
  s.push(u8(...sc4, 0x67, 0xAA));
  expect(Array.from(s.flush()[0]!)).toEqual([0x67, 0xAA]);
});

test('builds an avc1 codec string from SPS profile/constraints/level', () => {
  expect(codecStringFromSps(u8(0x67, 0x42, 0xE0, 0x1E))).toBe('avc1.42E01E');
  expect(codecStringFromSps(u8(0x67, 0x64, 0x00, 0x28))).toBe('avc1.640028');
});

test('codecStringFromSps rejects a too-short SPS', () => {
  expect(() => codecStringFromSps(u8(0x67, 0x42))).toThrow();
});
