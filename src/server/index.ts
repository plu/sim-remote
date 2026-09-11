import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { checkAuth, parseArgs, COOKIE } from './auth.ts';
import { listBootedSims } from './companion/discovery.ts';
import { CompanionSupervisor } from './companion/supervisor.ts';
import { IdbClient } from './idb/client.ts';
import { SessionHub, type Viewer } from './session/hub.ts';
import { isClientMsg, type ServerMsg } from '../shared/protocol.ts';

const cfg = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(here, '../../dist/client');

const supervisor = new CompanionSupervisor();
const hubs = new Map<string, Promise<SessionHub>>();
const videoSockets = new Map<string, WebSocket>();
let guestSeq = 0;

function hubFor(udid: string): Promise<SessionHub> {
  let h = hubs.get(udid);
  if (!h) {
    h = (async () => SessionHub.open(IdbClient.connect(await supervisor.socketFor(udid)), udid))();
    hubs.set(udid, h);
    h.catch(() => hubs.delete(udid));
  }
  return h;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json',
};

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuth(req, cfg)) { res.writeHead(401).end('unauthorized'); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (cfg.auth && url.searchParams.has('token')) {
    res.setHeader('Set-Cookie', `${COOKIE}=${cfg.token}; HttpOnly; SameSite=Strict; Path=/`);
    res.writeHead(302, { Location: url.pathname }).end();
    return;
  }

  if (url.pathname === '/api/sims') {
    try {
      const sims = await listBootedSims();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sims));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  try {
    const body = await readFile(join(CLIENT_DIR, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found — did you run `npm run build:client`?');
  }
}

const server = createServer((req, res) => {
  void onRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end('error'); });
});

const controlWss = new WebSocketServer({ noServer: true });
const videoWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req, cfg)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const control = /^\/ws\/([^/?]+)$/.exec(url.pathname);
  const video = /^\/video\/([^/?]+)$/.exec(url.pathname);
  if (control) controlWss.handleUpgrade(req, socket, head, (ws) => { void onControl(ws, control[1]!, url); });
  else if (video) videoWss.handleUpgrade(req, socket, head, (ws) => { onVideo(ws, url); });
  else socket.destroy();
});

async function onControl(ws: WebSocket, udid: string, url: URL): Promise<void> {
  const clientId = url.searchParams.get('cid') ?? randomUUID();
  const name = url.searchParams.get('name') ?? `Guest ${++guestSeq}`;

  let hub: SessionHub;
  try {
    hub = await hubFor(udid);
  } catch (e) {
    console.error('[hub]', (e as Error).message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'status', state: 'simulator-gone' } satisfies ServerMsg));
    }
    ws.close();
    return;
  }

  const viewer: Viewer = {
    id: clientId,
    name,
    send: (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
    sendVideo: (nal) => {
      const vs = videoSockets.get(clientId);
      // Drop for a backed-up viewer rather than buffering without bound.
      if (vs && vs.readyState === vs.OPEN && vs.bufferedAmount < 4_000_000) vs.send(nal);
    },
  };
  hub.addViewer(viewer);

  ws.on('message', (data) => {
    let parsed: unknown;
    try { parsed = JSON.parse(String(data)); } catch { return; }
    if (isClientMsg(parsed)) hub.handle(clientId, parsed);
  });
  ws.on('close', () => { hub.removeClient(clientId); videoSockets.delete(clientId); });
}

/** Video and control share a clientId so the hub treats them as one viewer. */
function onVideo(ws: WebSocket, url: URL): void {
  const cid = url.searchParams.get('cid');
  if (!cid) { ws.close(); return; }
  ws.binaryType = 'nodebuffer';
  videoSockets.set(cid, ws);
  ws.on('close', () => { if (videoSockets.get(cid) === ws) videoSockets.delete(cid); });
}

server.listen(cfg.port, cfg.host, () => {
  const suffix = cfg.auth ? `/?token=${cfg.token}` : '/';
  console.log(`sim-remote listening on http://${cfg.host}:${cfg.port}${suffix}`);
  if (!cfg.auth) console.warn('WARNING: auth disabled — anyone on this network can drive the simulator');
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const h of hubs.values()) void h.then((x) => x.close()).catch(() => {});
    supervisor.stopAll();
    server.close();
    setTimeout(() => process.exit(0), 300);
  });
}
