import { parseBootedDevices } from '../src/server/companion/discovery.ts';

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
  expect(parseBootedDevices(sample)).toEqual([
    { udid: 'AAA', name: 'iPhone 17 Pro', runtime: 'iOS 26.5' },
  ]);
});

test('tolerates empty device sets', () => {
  expect(parseBootedDevices(JSON.stringify({ devices: {} }))).toEqual([]);
});

test('tolerates a missing devices key', () => {
  expect(parseBootedDevices('{}')).toEqual([]);
});

test('throws a clear error on malformed json', () => {
  expect(() => parseBootedDevices('not json')).toThrow(/simctl/i);
});
