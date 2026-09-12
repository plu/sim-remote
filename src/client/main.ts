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

const ORIENTATIONS: Orientation[] = ['PORTRAIT', 'LANDSCAPE_LEFT', 'PORTRAIT_UPSIDE_DOWN', 'LANDSCAPE_RIGHT'];

const clientId = crypto.randomUUID();
let ws: WebSocket | null = null;
let videoWs: WebSocket | null = null;
let screen: ScreenPoints = { width: 402, height: 874 };
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
  if (retry) { clearTimeout(retry); retry = null; }
  ws?.close();
  videoWs?.close();
  player?.close();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  videoWs = new WebSocket(`${proto}://${location.host}/video/${udid}?cid=${clientId}`);
  videoWs.binaryType = 'arraybuffer';

  player = new H264Player(
    (frame) => {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
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
      canvas.style.aspectRatio = `${screen.width} / ${screen.height}`;
      recognizer = new GestureRecognizer(screen, () => canvas.getBoundingClientRect());
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
