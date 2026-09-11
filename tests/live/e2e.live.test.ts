import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { listBootedSims } from '../../src/server/companion/discovery.ts';
import { IdbClient } from '../../src/server/idb/client.ts';
import { nalType, isKeyframe, codecStringFromSps, NAL_SPS, NAL_PPS } from '../../src/server/video/nalu.ts';
import type { ClientMsg, ServerMsg } from '../../src/shared/protocol.ts';

const PORT = 8131;
const TOKEN = 'testtoken';
const CID = 'e2e-client';
const base = `ws://127.0.0.1:${PORT}`;

let server: ChildProcess;
let udid: string;
let ax: IdbClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const sims = await listBootedSims();
  if (sims.length === 0) throw new Error('live tests need a booted simulator');
  udid = sims[0]!.udid;

  server = spawn('node', ['src/server/index.ts', '--host', '127.0.0.1', '--port', String(PORT), '--token', TOKEN], { stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30_000);
    server.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) { clearTimeout(t); resolve(); }
    });
    server.on('error', reject);
  });
}, 120_000);

afterAll(async () => {
  ax?.close();
  server?.kill('SIGTERM');
  await sleep(500);
});

/** Opens video + control sockets sharing one clientId, as the browser does. */
async function openClient() {
  const nals: Uint8Array[] = [];
  const msgs: ServerMsg[] = [];
  const video = new WebSocket(`${base}/video/${udid}?cid=${CID}&token=${TOKEN}`);
  video.binaryType = 'arraybuffer';
  video.on('message', (d: Buffer) => nals.push(new Uint8Array(d)));
  await new Promise((r) => video.on('open', r));

  const control = new WebSocket(`${base}/ws/${udid}?cid=${CID}&token=${TOKEN}`);
  control.on('message', (d: Buffer) => msgs.push(JSON.parse(d.toString()) as ServerMsg));
  await new Promise((r) => control.on('open', r));

  return {
    nals, msgs, video, control,
    send: (m: ClientMsg) => control.send(JSON.stringify(m)),
    close: () => { control.close(); video.close(); },
  };
}

test('unauthenticated websocket upgrades are rejected', async () => {
  const ws = new WebSocket(`${base}/ws/${udid}?cid=nope`);
  const failed = await new Promise<boolean>((resolve) => {
    ws.on('error', () => resolve(true));
    ws.on('open', () => resolve(false));
  });
  expect(failed).toBe(true);
});

test('the browser handshake yields a point-space screen and video', async () => {
  const c = await openClient();
  await sleep(6000);

  const hello = c.msgs.find((m) => m.type === 'hello');
  expect(hello).toBeDefined();
  if (hello?.type !== 'hello') throw new Error('no hello');
  expect(hello.screen.width).toBeLessThan(1000);          // points, not pixels
  expect(hello.screen.height).toBeGreaterThan(hello.screen.width);

  const types = c.nals.map(nalType);
  expect(types).toContain(NAL_SPS);
  expect(types).toContain(NAL_PPS);
  expect(c.nals.some(isKeyframe)).toBe(true);

  const sps = c.nals.find((n) => nalType(n) === NAL_SPS)!;
  expect(codecStringFromSps(sps)).toMatch(/^avc1\.[0-9A-F]{6}$/);

  c.close();
}, 60_000);

test('claim-by-interaction makes the first toucher the controller', async () => {
  const c = await openClient();
  await sleep(3000);
  c.send({ type: 'touch', phase: 'down', x: 10, y: 10 });
  c.send({ type: 'touch', phase: 'up', x: 10, y: 10 });
  await sleep(1500);

  const control = [...c.msgs].reverse().find((m) => m.type === 'control');
  expect(control && control.type === 'control' && control.controllerId).toBe(CID);
  c.close();
}, 60_000);

test('a streamed drag through the websocket scrolls a real list', async () => {
  ax = IdbClient.connect(join(tmpdir(), 'sim-remote', `${udid}.sock`));
  const { screen } = await ax.describe();
  const c = await openClient();
  await sleep(3000);

  c.send({ type: 'button', button: 'HOME' });
  await sleep(2500);

  // Open Settings by tapping its accessibility frame centre.
  const tree = await ax.accessibilityInfo();
  const m = /"AXLabel"\s*:\s*"Settings"[\s\S]{0,400}?"frame"\s*:\s*\{([^}]*)\}/.exec(tree);
  if (!m) throw new Error('Settings icon not found on the home screen');
  const f = JSON.parse(`{${m[1]!}}`) as { x: number; y: number; width: number; height: number };
  const tapX = Math.round(f.x + f.width / 2);
  const tapY = Math.round(f.y + f.height / 2);
  c.send({ type: 'touch', phase: 'down', x: tapX, y: tapY });
  c.send({ type: 'touch', phase: 'up', x: tapX, y: tapY });
  await sleep(3500);

  const before = await ax.accessibilityInfo();
  const x = Math.round(screen.width / 2);
  const startY = Math.round(screen.height * 0.75);
  c.send({ type: 'touch', phase: 'down', x, y: startY });
  for (let i = 1; i <= 30; i++) {
    c.send({ type: 'touch', phase: 'move', x, y: Math.round(startY - i * screen.height * 0.012) });
    await sleep(12);
  }
  c.send({ type: 'touch', phase: 'up', x, y: Math.round(startY - 30 * screen.height * 0.012) });
  await sleep(3000);

  const after = await ax.accessibilityInfo();
  expect(after).not.toEqual(before);
  c.close();
}, 90_000);
