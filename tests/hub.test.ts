import { SessionHub, type Viewer } from '../src/server/session/hub.ts';
import type { ServerMsg } from '../src/shared/protocol.ts';

function fakeClient(ui: { width: number; height: number } = { width: 402, height: 874 }) {
  const calls: string[] = [];
  let emit: (c: Buffer) => void = () => {};
  return {
    calls,
    pushNal: (b: Buffer) => emit(b),
    describe: async () => ({ screen: { width: 402, height: 874 }, name: 'Fake', density: 3 }),
    uiSize: async () => ui,
    openHid: () => ({
      touch: (p: string, x: number, y: number) => calls.push(`touch:${p}:${x},${y}`),
      button: (b: string) => calls.push(`button:${b}`),
      key: (c: number, shift?: boolean) => calls.push(`key:${c}${shift ? '+shift' : ''}`),
      pinch: () => calls.push('pinch'),
      orientation: (o: string) => calls.push(`orientation:${o}`),
      end: () => calls.push('end'),
    }),
    startVideo: (onNal: (c: Buffer) => void) => {
      emit = onNal;
      return { stop: () => calls.push('videostop') };
    },
    close: () => calls.push('close'),
  };
}

interface TestViewer extends Viewer { msgs: ServerMsg[]; nals: Uint8Array[] }

function viewer(id: string): TestViewer {
  const v: TestViewer = {
    id, name: id, msgs: [], nals: [],
    send: (m) => { v.msgs.push(m); },
    sendVideo: (n) => { v.nals.push(n); },
  };
  return v;
}

const sc = (...b: number[]) => Buffer.from([0, 0, 0, 1, ...b]);
const open = async (c: ReturnType<typeof fakeClient>) =>
  SessionHub.open(c as never, 'UDID');

test('first touch claims control and reaches the simulator', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.handle('alice', { type: 'touch', phase: 'down', x: 5, y: 6 });
  expect(c.calls).toContain('touch:down:5,6');
});

test('a second viewer is view-only and its input is dropped', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.addViewer(viewer('bob'));
  hub.handle('alice', { type: 'touch', phase: 'down', x: 1, y: 1 });
  c.calls.length = 0;
  hub.handle('bob', { type: 'touch', phase: 'down', x: 9, y: 9 });
  expect(c.calls).toEqual([]);
});

test('takeControl lifts the previous controller held finger', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.addViewer(viewer('bob'));
  hub.handle('alice', { type: 'touch', phase: 'down', x: 3, y: 4 });
  c.calls.length = 0;
  hub.handle('bob', { type: 'takeControl' });
  expect(c.calls).toContain('touch:up:3,4');
});

test('the ousted controller is told who took over', async () => {
  const c = fakeClient();
  const hub = await open(c);
  const a = viewer('alice');
  hub.addViewer(a);
  hub.addViewer(viewer('bob'));
  hub.handle('alice', { type: 'touch', phase: 'down', x: 1, y: 1 });
  hub.handle('bob', { type: 'takeControl' });
  expect(a.msgs.some((m) => m.type === 'toast' && m.text.includes('bob'))).toBe(true);
});

test('a joining viewer gets SPS/PPS for decoder config', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('early'));
  c.pushNal(sc(0x67, 0x42, 0xE0, 0x1E));   // SPS
  c.pushNal(sc(0x68, 0xCE));               // PPS
  c.pushNal(sc(0x65, 0xAA));               // IDR keyframe
  c.pushNal(sc(0x41, 0xBB));               // non-IDR
  c.pushNal(sc(0x41, 0xCC));               // flushes the previous unit

  const late = viewer('late');
  hub.addViewer(late);
  const types = late.nals.map((n) => n[0]! & 0x1f);
  expect(types).toContain(7);
  expect(types).toContain(8);
});

test('a joining viewer is NOT given a stale keyframe', async () => {
  // Replaying an old keyframe and then feeding current deltas makes the
  // decoder reference frames it never saw: permanent corruption, then a
  // freeze once it errors. The joiner must wait for a fresh keyframe.
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('early'));
  c.pushNal(sc(0x67, 0x42, 0xE0, 0x1E));
  c.pushNal(sc(0x68, 0xCE));
  c.pushNal(sc(0x65, 0xAA));               // keyframe, now in the past
  c.pushNal(sc(0x41, 0xBB));
  c.pushNal(sc(0x41, 0xCC));

  const late = viewer('late');
  hub.addViewer(late);
  expect(late.nals.map((n) => n[0]! & 0x1f)).not.toContain(5);
});

test('video reaches every connected viewer', async () => {
  const c = fakeClient();
  const hub = await open(c);
  const a = viewer('a'); const b = viewer('b');
  hub.addViewer(a); hub.addViewer(b);
  c.pushNal(sc(0x65, 0x01));
  c.pushNal(sc(0x41, 0x02));
  expect(a.nals.length).toBe(1);
  expect(b.nals.length).toBe(1);
});

test('disconnecting the controller frees control', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.addViewer(viewer('bob'));
  hub.handle('alice', { type: 'touch', phase: 'down', x: 1, y: 1 });
  hub.removeClient('alice');
  hub.handle('bob', { type: 'touch', phase: 'down', x: 2, y: 2 });
  expect(c.calls).toContain('touch:down:2,2');
});

test('hardware buttons and rotation reach the simulator', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.handle('alice', { type: 'button', button: 'HOME' });
  hub.handle('alice', { type: 'orientation', orientation: 'LANDSCAPE_LEFT' });
  expect(c.calls).toContain('button:HOME');
  expect(c.calls).toContain('orientation:LANDSCAPE_LEFT');
});

test('renaming a viewer is reflected in the control broadcast', async () => {
  const c = fakeClient();
  const hub = await open(c);
  const a = viewer('alice');
  hub.addViewer(a);
  hub.handle('alice', { type: 'touch', phase: 'down', x: 1, y: 1 });
  hub.handle('alice', { type: 'setName', name: 'Alice' });
  const last = [...a.msgs].reverse().find((m) => m.type === 'control');
  expect(last && last.type === 'control' && last.controllerName).toBe('Alice');
});

test('text is sent as HID usage codes, not ASCII code points', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.handle('alice', { type: 'text', text: 'az' });
  expect(c.calls).toEqual(['key:4', 'key:29']);          // not 97 / 122
});

test('uppercase and shifted symbols carry a shift modifier', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.handle('alice', { type: 'text', text: 'A?' });
  expect(c.calls).toEqual(['key:4+shift', 'key:56+shift']);
});

test('unmappable characters are skipped rather than sent as a wrong key', async () => {
  const c = fakeClient();
  const hub = await open(c);
  hub.addViewer(viewer('alice'));
  hub.handle('alice', { type: 'text', text: 'aéb' });
  expect(c.calls).toEqual(['key:4', 'key:5']);
});

test('rotation broadcasts the orientation the UI actually adopted', async () => {
  // The device really is landscape, so a portrait request must not be echoed
  // back as portrait — viewers would render a rotation the device is not in.
  const c = fakeClient({ width: 874, height: 402 });
  const hub = await open(c);
  const a = viewer('alice');
  hub.addViewer(a);
  a.msgs.length = 0;

  hub.handle('alice', { type: 'orientation', orientation: 'PORTRAIT_UPSIDE_DOWN' });
  await new Promise((r) => setTimeout(r, 3600));

  const msg = a.msgs.find((m) => m.type === 'orientation');
  if (!msg || msg.type !== 'orientation') throw new Error('no orientation broadcast');
  expect(msg.orientation).toBe('LANDSCAPE_LEFT');
  expect(msg.screen).toEqual({ width: 874, height: 402 });
  expect(hub.screen).toEqual({ width: 874, height: 402 });
}, 15_000);

test('a landscape request is reported as the landscape side asked for', async () => {
  const c = fakeClient({ width: 874, height: 402 });
  const hub = await open(c);
  const a = viewer('alice');
  hub.addViewer(a);
  a.msgs.length = 0;

  hub.handle('alice', { type: 'orientation', orientation: 'LANDSCAPE_RIGHT' });
  await new Promise((r) => setTimeout(r, 1200));

  const msg = a.msgs.find((m) => m.type === 'orientation');
  if (!msg || msg.type !== 'orientation') throw new Error('no orientation broadcast');
  expect(msg.orientation).toBe('LANDSCAPE_RIGHT');
}, 15_000);
