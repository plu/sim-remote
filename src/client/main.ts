import { GestureRecognizer } from './gestures.ts';
import { H264Player } from './decoder.ts';
import { setBadge, toast } from './ui.ts';
import type {
  ClientMsg, ScreenPoints, ServerMsg, Orientation, HardwareButton,
} from '../shared/protocol.ts';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const simsEl = document.getElementById('sims') as HTMLSelectElement;
const takeBtn = document.getElementById('take') as HTMLButtonElement;

// Upside-down portrait is deliberately not in the cycle: most iPhone apps
// refuse it, so it either does nothing or leaves the device in a state that
// does not match what was asked for.
const ORIENTATIONS: Orientation[] = ['PORTRAIT', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT'];

/** Degrees the portrait framebuffer must be turned to appear upright. */
const ROTATION: Record<Orientation, number> = {
  PORTRAIT: 0,
  LANDSCAPE_LEFT: 90,
  PORTRAIT_UPSIDE_DOWN: 180,
  LANDSCAPE_RIGHT: 270,
};

const clientId = crypto.randomUUID();
let ws: WebSocket | null = null;
let videoWs: WebSocket | null = null;
let screen: ScreenPoints = { width: 402, height: 874 };
let density = 3;
let rotationDeg = 0;   // how far the frame must be turned to look upright
let recognizer: GestureRecognizer | null = null;
let player: H264Player | null = null;
let controlling = false;
let orientationIdx = 0;
let currentUdid: string | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

const send = (m: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const sendAll = (ms: ClientMsg[]) => { for (const m of ms) send(m); };

async function loadSims(): Promise<void> {
  let sims: Array<{ udid: string; name: string; runtime: string }> = [];
  try {
    sims = await (await fetch('/api/sims')).json();
  } catch {
    setBadge('could not reach server', false);
    return;
  }
  simsEl.replaceChildren();
  for (const s of sims) {
    const o = document.createElement('option');
    o.value = s.udid;
    o.textContent = `${s.name} — ${s.runtime}`;
    simsEl.append(o);
  }
  if (sims.length === 0) { setBadge('no booted simulators', false); return; }
  connect(simsEl.value);
}

function connect(udid: string): void {
  currentUdid = udid;
  rotationDeg = 0;
  if (retry) { clearTimeout(retry); retry = null; }
  ws?.close();
  videoWs?.close();
  player?.close();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  videoWs = new WebSocket(`${proto}://${location.host}/video/${udid}?cid=${clientId}`);
  videoWs.binaryType = 'arraybuffer';

  player = new H264Player(
    (frame) => {
      // iOS rotates the UI *inside* a fixed portrait framebuffer, so the frame
      // never changes shape. Turn it at draw time instead: the canvas then has
      // the real landscape shape, the bezel rotates with it, and pointer
      // mapping stays a plain linear fit to the canvas box.
      const turned = rotationDeg === 90 || rotationDeg === 270;
      const w = turned ? frame.displayHeight : frame.displayWidth;
      const h = turned ? frame.displayWidth : frame.displayHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.aspectRatio = `${w} / ${h}`;
      }
      ctx.save();
      ctx.translate(w / 2, h / 2);
      if (rotationDeg !== 0) ctx.rotate((rotationDeg * Math.PI) / 180);
      ctx.drawImage(frame, -frame.displayWidth / 2, -frame.displayHeight / 2);
      ctx.restore();
      frame.close();
    },
    (m) => setBadge(m, false),
  );
  videoWs.onmessage = (e) => player?.push(new Uint8Array(e.data as ArrayBuffer));

  ws = new WebSocket(`${proto}://${location.host}/ws/${udid}?cid=${clientId}`);
  ws.onmessage = (e) => onServerMsg(JSON.parse(e.data as string) as ServerMsg);
  ws.onclose = () => {
    setBadge('disconnected — retrying', false);
    if (!retry && currentUdid) retry = setTimeout(() => { retry = null; connect(currentUdid!); }, 2000);
  };
}

function onServerMsg(m: ServerMsg): void {
  switch (m.type) {
    case 'hello':
      screen = m.screen;
      density = m.density;
      rotationDeg = ROTATION[m.orientation];
      // Start the Rotate cycle from where the device actually is, or the first
      // click is a no-op.
      orientationIdx = Math.max(0, ORIENTATIONS.indexOf(m.orientation));
      canvas.style.aspectRatio = `${screen.width} / ${screen.height}`;
      // Read `screen` live: it is replaced when the device rotates.
      recognizer = new GestureRecognizer(() => screen, () => canvas.getBoundingClientRect());
      break;
    case 'control':
      controlling = m.controllerId === clientId;
      canvas.classList.toggle('viewonly', !controlling && m.controllerId !== null);
      takeBtn.hidden = controlling || m.controllerId === null;
      setBadge(
        controlling ? 'You are driving'
          : m.controllerName ? `${m.controllerName} is driving`
          : 'nobody driving — touch to take over',
        controlling,
      );
      break;
    case 'orientation':
      screen = m.screen;
      rotationDeg = ROTATION[m.orientation];
      orientationIdx = Math.max(0, ORIENTATIONS.indexOf(m.orientation));
      break;
    case 'toast':
      toast(m.text);
      break;
    case 'status':
      if (m.state === 'simulator-gone') setBadge('simulator is gone', false);
      break;
  }
}

canvas.addEventListener('pointerdown', (e) => {
  // Capture keeps a drag alive outside the canvas, but must never break input
  // if the pointer id is not capturable.
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  sendAll(recognizer?.pointerDown(e) ?? []);
});
canvas.addEventListener('pointermove', (e) => {
  // getCoalescedEvents() can return an EMPTY array, not just be absent — then
  // `?? [e]` does not help and every move is silently dropped, killing drags.
  const coalesced = e.getCoalescedEvents?.() ?? [];
  const moves = coalesced.length > 0 ? coalesced : [e];
  for (const ce of moves) {
    sendAll(recognizer?.pointerMove({ clientX: ce.clientX, clientY: ce.clientY, pointerId: e.pointerId }) ?? []);
  }
});
const up = (e: PointerEvent) => sendAll(recognizer?.pointerUp(e) ?? []);
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
// A trackpad emits pinch wheel events at ~60/s. idb's pinch is a canned
// server-side gesture, so firing one per tick would stack dozens of overlapping
// animations. Accumulate, then send a single pinch once the gesture settles.
let pinchTimer: ReturnType<typeof setTimeout> | null = null;
canvas.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  recognizer?.wheel(e);
  if (pinchTimer) clearTimeout(pinchTimer);
  pinchTimer = setTimeout(() => {
    pinchTimer = null;
    const m = recognizer?.takePinch();
    if (m) send(m);
  }, 120);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement | null)?.tagName === 'SELECT') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1) { send({ type: 'text', text: e.key }); e.preventDefault(); }
  else if (e.key === 'Backspace') { send({ type: 'key', keycode: 42 }); e.preventDefault(); }
  else if (e.key === 'Enter') { send({ type: 'key', keycode: 40 }); e.preventDefault(); }
});

takeBtn.addEventListener('click', () => send({ type: 'takeControl' }));
simsEl.addEventListener('change', () => connect(simsEl.value));

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-button]')) {
  b.addEventListener('click', () => send({ type: 'button', button: b.dataset.button as HardwareButton }));
}
document.getElementById('rotate')?.addEventListener('click', () => {
  orientationIdx = (orientationIdx + 1) % ORIENTATIONS.length;
  send({ type: 'orientation', orientation: ORIENTATIONS[orientationIdx]! });
});

void loadSims();


// --- drag & drop app install -------------------------------------------------

const dropEl = document.getElementById('drop')!;
const progressEl = document.getElementById('progress')!;

function setProgress(fraction: number): void {
  progressEl.style.width = `${Math.round(fraction * 100)}%`;
  if (fraction >= 1) setTimeout(() => { progressEl.style.width = '0'; }, 600);
}

function uploadZip(file: File): void {
  const udid = simsEl.value;
  if (!udid) { toast('No simulator selected'); return; }
  if (!/\.zip$/i.test(file.name)) { toast('Drop a .zip containing an .app bundle'); return; }

  toast(`Uploading ${file.name}…`);
  // XHR rather than fetch: it reports upload progress, and these are big files.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/install/${udid}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(e.loaded / e.total); };
  xhr.onload = () => {
    setProgress(1);
    if (xhr.status === 200) return;   // the server toasts success to everyone
    let msg = xhr.responseText;
    try { msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg; } catch { /* plain text */ }
    toast(`Install failed: ${msg}`);
  };
  xhr.onerror = () => { setProgress(0); toast('Upload failed'); };
  xhr.send(file);
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropEl.classList.add('over');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  // dragleave fires for child elements too; only hide when truly gone.
  if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('over'); }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('over');
  const file = e.dataTransfer?.files?.[0];
  if (file) uploadZip(file);
});
