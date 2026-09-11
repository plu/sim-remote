import { credentials, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  HardwareButton, Orientation, ScreenPoints, TouchPhase,
} from '../../shared/protocol.ts';
import { pixelsToPoints } from '../../shared/coords.ts';
import { HID_LEFT_SHIFT } from '../../shared/keymap.ts';

const PROTO = join(dirname(fileURLToPath(import.meta.url)), '../../../proto/idb.proto');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const def = loadSync(PROTO, { keepCase: true, longs: String, defaults: true });
const idbPkg = (loadPackageDefinition(def) as Any).idb;

const point = (x: number, y: number) => ({ x, y });
const press = (action: unknown, direction: 'DOWN' | 'UP') => ({ press: { action, direction } });

export interface HidStream {
  touch(phase: TouchPhase, x: number, y: number): void;
  button(b: HardwareButton): void;
  key(code: number, shift?: boolean): void;
  pinch(x: number, y: number, scale: number, duration: number): void;
  orientation(o: Orientation): void;
  end(): void;
}

export interface VideoHandle { stop(): void }

export class IdbClient {
  #raw: Any;

  private constructor(raw: Any) { this.#raw = raw; }

  static connect(socketPath: string): IdbClient {
    return new IdbClient(
      new idbPkg.CompanionService(`unix://${socketPath}`, credentials.createInsecure()),
    );
  }

  describe(): Promise<{ screen: ScreenPoints; name: string }> {
    return new Promise((resolve, reject) => {
      this.#raw.describe({}, (err: Error | null, r: Any) => {
        if (err) return reject(err);
        const d = r?.target_description;
        const dim = d?.screen_dimensions;
        if (!dim) return reject(new Error('simulator reported no screen dimensions'));
        resolve({
          name: String(d.name ?? 'Simulator'),
          screen: pixelsToPoints(Number(dim.width), Number(dim.height), Number(dim.density) || 1),
        });
      });
    });
  }

  /** One long-lived client-streaming HID call carries every input event. */
  openHid(onError: (e: Error) => void): HidStream {
    const call = this.#raw.hid((err: Error | null) => { if (err) onError(err); });
    const w = (ev: unknown) => { try { call.write(ev); } catch (e) { onError(e as Error); } };
    return {
      touch: (phase, x, y) =>
        w(press({ touch: { point: point(x, y) } }, phase === 'up' ? 'UP' : 'DOWN')),
      button: (b) => { w(press({ button: { button: b } }, 'DOWN')); w(press({ button: { button: b } }, 'UP')); },
      key: (code, shift = false) => {
        const k = { key: { keycode: code } };
        const sh = { key: { keycode: HID_LEFT_SHIFT } };
        if (shift) w(press(sh, 'DOWN'));
        w(press(k, 'DOWN'));
        w(press(k, 'UP'));
        if (shift) w(press(sh, 'UP'));
      },
      pinch: (x, y, scale, duration) => w({ pinch: { center: point(x, y), scale, duration, radius: 100 } }),
      orientation: (o) => w({ orientation: { orientation: o } }),
      end: () => { try { call.end(); } catch { /* already closed */ } },
    };
  }

  startVideo(onNal: (chunk: Buffer) => void, onError: (e: Error) => void): VideoHandle {
    const call = this.#raw.video_stream();
    call.on('data', (m: Any) => { if (m?.payload?.data?.length) onNal(m.payload.data as Buffer); });
    call.on('error', (e: Error) => onError(e));
    call.write({
      start: {
        fps: 30, format: 'H264', compression_quality: 0.7, scale_factor: 1.0,
        avg_bitrate: 4_000_000, key_frame_rate: 30,
      },
    });
    return { stop: () => { try { call.write({ stop: {} }); call.end(); } catch { /* closed */ } } };
  }

  accessibilityInfo(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.#raw.accessibility_info({ format: 'NESTED' }, (err: Error | null, r: Any) =>
        err ? reject(err) : resolve(String(r?.json ?? '')));
    });
  }

  screenshot(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.#raw.screenshot({}, (err: Error | null, r: Any) =>
        err ? reject(err) : resolve(r.image_data as Buffer));
    });
  }

  close(): void { this.#raw.close?.(); }
}
