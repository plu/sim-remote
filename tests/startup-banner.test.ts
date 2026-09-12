import { readFileSync } from 'node:fs';

// The live e2e test waits for this exact phrase on stdout to know the server
// is up. Changing the banner without changing the test made CI hang for 30s
// and report "server did not start", so pin them together.
test('the server banner still contains the phrase the live test waits for', () => {
  const server = readFileSync('src/server/index.ts', 'utf8');
  const liveTest = readFileSync('tests/live/e2e.live.test.ts', 'utf8');

  const phrase = /const READY = '([^']+)'/.exec(liveTest)?.[1];
  expect(phrase).toBeTruthy();
  expect(server).toContain(phrase!);
});
