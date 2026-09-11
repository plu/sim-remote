import { codecStringFromSps, nalType, isKeyframe, NAL_SPS, NAL_PPS } from '../server/video/nalu.ts';

/**
 * Feeds Annex-B NAL units into a WebCodecs VideoDecoder.
 * Configuration waits for an SPS; decoding waits for the first keyframe.
 */
export class H264Player {
  #decoder: VideoDecoder | null = null;
  #configured = false;
  #sawKeyframe = false;
  #sps: Uint8Array | null = null;
  #pps: Uint8Array | null = null;
  #ts = 0;
  #onFrame: (f: VideoFrame) => void;
  #onError: (m: string) => void;

  constructor(onFrame: (f: VideoFrame) => void, onError: (m: string) => void) {
    this.#onFrame = onFrame;
    this.#onError = onError;
  }

  static supported(): boolean { return typeof VideoDecoder !== 'undefined'; }

  push(nal: Uint8Array): void {
    const t = nalType(nal);
    if (t === NAL_SPS) { this.#sps = nal; this.#configure(); return; }
    if (t === NAL_PPS) { this.#pps = nal; return; }
    if (!this.#configured) return;

    const key = isKeyframe(nal);
    if (!this.#sawKeyframe && !key) return;   // wait for a clean start
    if (key) this.#sawKeyframe = true;

    // Prepend SPS/PPS to each keyframe so recovery never needs a new stream.
    const parts = key && this.#sps && this.#pps ? [this.#sps, this.#pps, nal] : [nal];
    try {
      this.#decoder!.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: this.#ts,
        data: this.#annexB(parts) as unknown as BufferSource,
      }));
      this.#ts += 33_333;
    } catch {
      this.#recover();
    }
  }

  #annexB(units: Uint8Array[]): Uint8Array {
    const total = units.reduce((n, u) => n + 4 + u.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const u of units) {
      out.set([0, 0, 0, 1], o); o += 4;
      out.set(u, o); o += u.length;
    }
    return out;
  }

  #configure(): void {
    if (this.#configured || !this.#sps) return;
    if (!H264Player.supported()) {
      this.#onError('This browser has no WebCodecs support. Use Chrome, Edge, Firefox 130+, or Safari 16.4+.');
      return;
    }
    this.#decoder = new VideoDecoder({
      output: (f) => this.#onFrame(f),
      error: () => this.#recover(),
    });
    this.#decoder.configure({
      codec: codecStringFromSps(this.#sps),
      optimizeForLatency: true,
    });
    this.#configured = true;
  }

  /** On decode error, drop everything until the next keyframe. */
  #recover(): void { this.#sawKeyframe = false; }

  close(): void { try { this.#decoder?.close(); } catch { /* already closed */ } }
}
