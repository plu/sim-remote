import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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


interface AxNode {
  AXLabel?: string | null;
  traits?: string[];
  frame?: { x: number; y: number; width: number; height: number };
  children?: AxNode[];
}

/** Walk the accessibility tree. Regexing it is unsafe: the JSON key order
 *  varies between reads, so "AXLabel before frame" does not always hold. */
function findNode(nodes: AxNode[], pred: (n: AxNode) => boolean): AxNode | null {
  for (const n of nodes) {
    if (pred(n)) return n;
    const hit = n.children ? findNode(n.children, pred) : null;
    if (hit) return hit;
  }
  return null;
}

function centreOf(tree: string, label: string): { x: number; y: number } {
  const node = findNode(JSON.parse(tree) as AxNode[],
    (n) => n.AXLabel === label && (n.traits?.includes('LaunchIcon') ?? false));
  if (!node?.frame) throw new Error(`no launch icon labelled "${label}" on screen`);
  const f = node.frame;
  return { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) };
}

/** The server spawns a companion lazily, on the first websocket connection, so
 *  its socket does not exist until then. Call this only AFTER openClient(). */
async function connectAx(): Promise<IdbClient> {
  const path = join(tmpdir(), 'sim-remote', `${udid}.sock`);
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > 30_000) throw new Error('companion socket never appeared');
    await sleep(250);
  }
  return IdbClient.connect(path);
}

/** Poll the accessibility tree instead of sleeping a fixed amount: the
 *  simulator's starting state and animation timing both vary between runs. */
async function waitForTree(
  pred: (t: string) => boolean, label: string, timeoutMs = 20_000,
): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = await ax.accessibilityInfo();
    if (pred(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Return to the home screen and let the transition finish.
 *  The settle delay is load-bearing: waiting only on a tree condition returns
 *  instantly when the condition is already true, and a gesture sent into a
 *  running transition animation is swallowed. */
async function goHome(c: { send: (m: ClientMsg) => void }): Promise<void> {
  c.send({ type: 'button', button: 'HOME' });
  await sleep(2000);
  await waitForTree((t) => t.includes('"AXLabel":"Settings"'), 'the home screen');
  await sleep(800);
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
  const c = await openClient();
  ax ??= await connectAx();
  const { screen } = await ax.describe();

  await goHome(c);

  // Open Settings by tapping its accessibility frame centre.
  const { x: tapX, y: tapY } = centreOf(await ax.accessibilityInfo(), 'Settings');
  // A down/up pair sent back-to-back is a zero-duration touch, which iOS does
  // not reliably treat as a tap. Hold briefly, as a finger would.
  c.send({ type: 'touch', phase: 'down', x: tapX, y: tapY });
  await sleep(80);
  c.send({ type: 'touch', phase: 'up', x: tapX, y: tapY });
  // Wait for "left the home screen" rather than for a specific row: iOS
  // restores Settings' previous scroll position, so named rows may be off-screen.
  const before = await waitForTree(
    (t) => !t.includes('spotlight-pill'), 'Settings to open');
  await sleep(800);
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

test('typed text arrives as the right characters, not ASCII-as-usage-codes', async () => {
  const c = await openClient();
  ax ??= await connectAx();
  const { screen } = await ax.describe();

  // Open Spotlight: swipe down from the middle of the home screen.
  await goHome(c);
  const x = Math.round(screen.width / 2);
  const y0 = Math.round(screen.height * 0.35);
  c.send({ type: 'touch', phase: 'down', x, y: y0 });
  for (let i = 1; i <= 20; i++) {
    c.send({ type: 'touch', phase: 'move', x, y: y0 + i * 12 });
    await sleep(12);
  }
  c.send({ type: 'touch', phase: 'up', x, y: y0 + 240 });
  await sleep(2500);

  const typed = 'Hi?';
  for (const ch of typed) { c.send({ type: 'text', text: ch }); await sleep(250); }
  await sleep(2500);

  const tree = await ax.accessibilityInfo();
  expect(tree).toContain(typed);        // 'Hi?' — uppercase and a shifted symbol
  c.close();
}, 90_000);
