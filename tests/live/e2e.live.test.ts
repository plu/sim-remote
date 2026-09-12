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
/** Must match what the server prints on startup. */
const READY = 'sim-remote ready';

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
      if (d.toString().includes(READY)) { clearTimeout(t); resolve(); }
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

/** Wait for a message to arrive rather than guessing at a sleep. The first
 *  client through pays the companion's cold start, which is slow on CI. */
async function waitForMessage<T extends ServerMsg['type']>(
  client: { msgs: ServerMsg[] }, type: T, label: string, timeoutMs = 90_000,
): Promise<Extract<ServerMsg, { type: T }>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.msgs.find((m) => m.type === type);
    if (hit) return hit as Extract<ServerMsg, { type: T }>;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Wait for a condition on the accumulating video bytes. */
async function waitFor(
  cond: () => boolean, label: string, timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (cond()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
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
  pred: (t: string) => boolean, label: string, timeoutMs = 45_000,
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
  const hello = await waitForMessage(c, 'hello', 'the handshake');
  await waitFor(() => c.nals.some(isKeyframe), 'a keyframe');
  // Both dimensions are points, not pixels. Which one is larger depends on the
  // device's current orientation, so assert against the reported orientation
  // rather than assuming portrait.
  expect(hello.screen.width).toBeLessThan(1000);
  expect(hello.screen.height).toBeLessThan(1000);
  const portrait = hello.orientation === 'PORTRAIT' || hello.orientation === 'PORTRAIT_UPSIDE_DOWN';
  expect(hello.screen.height > hello.screen.width).toBe(portrait);

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

  // Launch Settings by bundle id rather than tapping its icon. Tapping is what
  // this suite exists to prove elsewhere; using it as *setup* made the test
  // depend on icon position and launch timing, which is where it kept failing.
  // Terminate first: iOS restores an app where it was left, and Settings
  // resuming into search mode has no top-level rows to scroll.
  await ax.terminateApp('com.apple.Preferences');
  await ax.launchApp('com.apple.Preferences');
  const before = await waitForTree(
    (t) => t.includes('"AXLabel":"General"') || t.includes('"AXLabel":"Wi-Fi"')
        || t.includes('"AXLabel":"Privacy & Security"'),
    'the Settings list',
  );

  const x = Math.round(screen.width / 2);
  const startY = Math.round(screen.height * 0.75);
  c.send({ type: 'touch', phase: 'down', x, y: startY });
  for (let i = 1; i <= 30; i++) {
    c.send({ type: 'touch', phase: 'move', x, y: Math.round(startY - i * screen.height * 0.012) });
    await sleep(12);
  }
  c.send({ type: 'touch', phase: 'up', x, y: Math.round(startY - 30 * screen.height * 0.012) });
  await sleep(2500);

  const after = await ax.accessibilityInfo();
  expect(after).not.toEqual(before);
  c.close();
}, 90_000);

test('typed text arrives as the right characters, not ASCII-as-usage-codes', async () => {
  const c = await openClient();
  ax ??= await connectAx();
  const { screen } = await ax.describe();

  await goHome(c);
  const x = Math.round(screen.width / 2);
  const y0 = Math.round(screen.height * 0.35);
  const spotlightOpen = (t: string) => t.includes('Suggestions') || t.includes('Search in Apps');

  // A swipe is occasionally swallowed mid-animation, so retry rather than
  // failing the whole run over one lost gesture.
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    c.send({ type: 'touch', phase: 'down', x, y: y0 });
    for (let i = 1; i <= 20; i++) {
      c.send({ type: 'touch', phase: 'move', x, y: y0 + i * 12 });
      await sleep(12);
    }
    c.send({ type: 'touch', phase: 'up', x, y: y0 + 240 });
    try {
      await waitForTree(spotlightOpen, `Spotlight (attempt ${attempt})`, 15_000);
      opened = true;
    } catch {
      await goHome(c);
    }
  }
  expect(opened).toBe(true);

  const typed = 'Hi?';
  for (const ch of typed) { c.send({ type: 'text', text: ch }); await sleep(250); }

  // 'Hi?' exercises an uppercase letter and a shifted symbol.
  await waitForTree((t) => t.includes(typed), `the typed text ${typed}`);
  c.close();
}, 90_000);
