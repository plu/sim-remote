export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

export function nalType(nalu: Uint8Array): number {
  return (nalu[0] ?? 0) & 0x1f;
}

export function isKeyframe(nalu: Uint8Array): boolean {
  return nalType(nalu) === NAL_IDR;
}

/** WebCodecs config string, e.g. 'avc1.42E01E' — bytes 1..3 of the SPS NAL unit. */
export function codecStringFromSps(sps: Uint8Array): string {
  if (sps.length < 4) throw new Error('SPS too short to derive codec string');
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
}

interface Start { at: number; len: number }

/** Locate Annex-B start codes, skipping past each match so 00 00 00 01 is
 *  detected once as a 4-byte code rather than twice (4-byte then 3-byte). */
function findStarts(buf: Uint8Array): Start[] {
  const starts: Start[] = [];
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) { starts.push({ at: i, len: 3 }); i += 3; continue; }
      if (buf[i + 2] === 0 && buf[i + 3] === 1) { starts.push({ at: i, len: 4 }); i += 4; continue; }
    }
    i++;
  }
  return starts;
}

/**
 * Streaming Annex-B splitter. Emits NAL units without their start codes.
 * A unit is emitted only once the NEXT start code is seen, so the trailing
 * unit stays buffered until more data arrives (or flush() is called).
 */
export class NaluSplitter {
  #buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf, 0);
    merged.set(chunk, this.#buf.length);

    const starts = findStarts(merged);
    if (starts.length === 0) { this.#buf = merged; return []; }

    const out: Uint8Array[] = [];
    for (let k = 0; k + 1 < starts.length; k++) {
      const s = starts[k]!;
      const unit = merged.slice(s.at + s.len, starts[k + 1]!.at);
      if (unit.length > 0) out.push(unit);
    }
    const last = starts[starts.length - 1]!;
    this.#buf = merged.slice(last.at);
    return out;
  }

  /** Emit the final buffered unit (stream ended). */
  flush(): Uint8Array[] {
    const starts = findStarts(this.#buf);
    if (starts.length === 0) { this.#buf = new Uint8Array(0); return []; }
    const s = starts[0]!;
    const unit = this.#buf.slice(s.at + s.len);
    this.#buf = new Uint8Array(0);
    return unit.length > 0 ? [unit] : [];
  }
}
