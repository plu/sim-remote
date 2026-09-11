import type { ClientMsg, ScreenPoints, ServerMsg } from '../../shared/protocol.ts';
import type { HidStream, IdbClient, VideoHandle } from '../idb/client.ts';
import { NaluSplitter, nalType, isKeyframe, NAL_SPS, NAL_PPS } from '../video/nalu.ts';
import { ControlArbiter } from './arbiter.ts';
import { charToHid } from '../../shared/keymap.ts';

export interface Viewer {
  id: string;
  name: string;
  send(msg: ServerMsg): void;
  sendVideo(nal: Uint8Array): void;
}

/** One per simulator: a single HID stream and a single video stream, fanned out. */
export class SessionHub {
  readonly udid: string;
  readonly screen: ScreenPoints;

  #client: IdbClient;
  #hid: HidStream;
  #video: VideoHandle | null = null;
  #viewers = new Map<string, Viewer>();
  #arbiter = new ControlArbiter();
  #splitter = new NaluSplitter();
  #sps: Uint8Array | null = null;
  #pps: Uint8Array | null = null;
  #lastKeyframe: Uint8Array | null = null;

  private constructor(client: IdbClient, udid: string, screen: ScreenPoints, hid: HidStream) {
    this.#client = client;
    this.udid = udid;
    this.screen = screen;
    this.#hid = hid;
  }

  static async open(client: IdbClient, udid: string): Promise<SessionHub> {
    const { screen } = await client.describe();
    const hid = client.openHid((e) => console.error('[hid]', e.message));
    const hub = new SessionHub(client, udid, screen, hid);
    hub.#video = client.startVideo(
      (c) => hub.#onVideo(c),
      (e) => console.error('[video]', e.message),
    );
    return hub;
  }

  /** Read-only access for live tests that assert via the accessibility tree. */
  get client(): IdbClient { return this.#client; }

  #onVideo(chunk: Buffer): void {
    for (const nal of this.#splitter.push(new Uint8Array(chunk))) {
      const t = nalType(nal);
      if (t === NAL_SPS) this.#sps = nal;
      else if (t === NAL_PPS) this.#pps = nal;
      else if (isKeyframe(nal)) this.#lastKeyframe = nal;
      for (const v of this.#viewers.values()) v.sendVideo(nal);
    }
  }

  addViewer(v: Viewer): () => void {
    this.#viewers.set(v.id, v);
    v.send({ type: 'hello', udid: this.udid, clientId: v.id, name: v.name, screen: this.screen });
    // Replay decoder init so a joiner paints without waiting for the next keyframe.
    if (this.#sps) v.sendVideo(this.#sps);
    if (this.#pps) v.sendVideo(this.#pps);
    if (this.#lastKeyframe) v.sendVideo(this.#lastKeyframe);
    this.#broadcastControl();
    return () => this.removeClient(v.id);
  }

  removeClient(id: string): void {
    const handover = this.#arbiter.release(id);
    if (handover.synthesizeUp) {
      this.#hid.touch('up', handover.synthesizeUp.x, handover.synthesizeUp.y);
    }
    this.#viewers.delete(id);
    this.#broadcastControl();
  }

  handle(clientId: string, msg: ClientMsg): void {
    if (msg.type === 'setName') {
      const v = this.#viewers.get(clientId);
      if (v) { v.name = msg.name; this.#broadcastControl(); }
      return;
    }

    if (msg.type === 'takeControl') {
      const h = this.#arbiter.takeControl(clientId);
      if (h.synthesizeUp) this.#hid.touch('up', h.synthesizeUp.x, h.synthesizeUp.y);
      if (h.previous && h.previous !== clientId) {
        const taker = this.#viewers.get(clientId)?.name ?? 'Someone';
        this.#viewers.get(h.previous)?.send({ type: 'toast', text: `${taker} took control` });
      }
      this.#broadcastControl();
      return;
    }

    // Claim-by-interaction: when control is free, acting on it takes it.
    if (this.#arbiter.controller === null && this.#arbiter.claimIfFree(clientId)) {
      this.#broadcastControl();
    }
    if (!this.#arbiter.canAccept(clientId)) return;

    switch (msg.type) {
      case 'touch':
        this.#arbiter.noteTouch(clientId, msg.phase, msg.x, msg.y);
        this.#hid.touch(msg.phase, msg.x, msg.y);
        break;
      case 'button': this.#hid.button(msg.button); break;
      case 'key': this.#hid.key(msg.keycode); break;
      case 'text':
        for (const ch of msg.text) {
          const k = charToHid(ch);
          if (k) this.#hid.key(k.code, k.shift);   // skip rather than send a wrong key
        }
        break;
      case 'orientation': this.#hid.orientation(msg.orientation); break;
      case 'pinch': this.#hid.pinch(msg.x, msg.y, msg.scale, msg.duration); break;
    }
  }

  #broadcastControl(): void {
    const id = this.#arbiter.controller;
    const msg: ServerMsg = {
      type: 'control',
      controllerId: id,
      controllerName: id ? this.#viewers.get(id)?.name ?? null : null,
    };
    for (const v of this.#viewers.values()) v.send(msg);
  }

  close(): void {
    this.#video?.stop();
    this.#hid.end();
    this.#client.close();
  }
}
