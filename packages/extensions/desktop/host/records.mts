/**
 * The helper's stdout, read back into records (helper/PROTOCOL.md, "stdout: binary records"):
 *
 *     u32le length of the rest (= 10 + payload) · u8 kind · u8 flags (bit 0 = key) · u64le ptsMicros · payload
 *
 * A pipe hands bytes over in whatever pieces it likes, so a header can arrive split across two
 * chunks and one chunk can carry many records. Pure: bytes in, records out.
 *
 * A length that cannot be one of ours (under 10, or past `RECORD_MAX`) means the stream is no
 * longer framed, and there is no resynchronising a length-prefixed stream: the reader stops for
 * good and says why in `broken`. It never throws.
 */

export const KIND_H264 = 1;
export const KIND_JPEG = 2;
export const KIND_JSON = 4;

/** A record past this is not a frame of ours (a 4K JPEG at q100 is ~5 MB). */
export const RECORD_MAX = 32 * 1024 * 1024;

export interface HelperRecord {
  kind: number;
  key: boolean;
  ptsMicros: bigint;
  payload: Buffer;
}

export class RecordReader {
  private chunks: Buffer[] = [];
  private have = 0;
  /** Why the stream stopped being readable, or null while it is fine. */
  broken: string | null = null;

  /** Feed one chunk; every record it completes, in order. */
  push(chunk: Uint8Array): HelperRecord[] {
    if (this.broken || chunk.byteLength === 0) return [];
    this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.have += chunk.byteLength;
    const out: HelperRecord[] = [];
    for (;;) {
      if (this.have < 4) break;
      const n = this.peekU32();
      if (n < 10 || n > RECORD_MAX) {
        this.broken = `a record ${n < 10 ? "too short" : "too long"} to be one (length ${n})`;
        this.chunks = [];
        this.have = 0;
        break;
      }
      if (this.have < 4 + n) break;
      const buf = this.take(4 + n);
      out.push({
        kind: buf[4],
        key: (buf[5] & 1) === 1,
        ptsMicros: buf.readBigUInt64LE(6),
        payload: buf.subarray(14),
      });
    }
    return out;
  }

  /** Bytes held for a record not yet complete. */
  get pending(): number { return this.have; }

  private peekU32(): number {
    const first = this.chunks[0];
    if (first.byteLength >= 4) return first.readUInt32LE(0);
    const head = Buffer.concat(this.chunks, Math.min(this.have, 4));
    return head.readUInt32LE(0);
  }

  /** The first `n` held bytes as one buffer (one concat per record, never per chunk). */
  private take(n: number): Buffer {
    let buf: Buffer;
    const first = this.chunks[0];
    if (first.byteLength >= n) {
      buf = first.subarray(0, n);
      if (first.byteLength === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
    } else {
      const all = Buffer.concat(this.chunks, this.have);
      buf = all.subarray(0, n);
      this.chunks = all.byteLength > n ? [all.subarray(n)] : [];
    }
    this.have -= n;
    return buf;
  }
}

/** A kind-4 record's JSON object, or null when it is not one. */
export function jsonRecord(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One record as the helper writes it. Tests and the fake helper build their stdout with this. */
export function encodeRecord(kind: number, key: boolean, ptsMicros: bigint, payload: Uint8Array): Buffer {
  const out = Buffer.alloc(14 + payload.byteLength);
  out.writeUInt32LE(10 + payload.byteLength, 0);
  out[4] = kind;
  out[5] = key ? 1 : 0;
  out.writeBigUInt64LE(ptsMicros, 6);
  out.set(payload, 14);
  return out;
}
