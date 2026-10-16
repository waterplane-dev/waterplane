/**
 * What the player needs to know about an H.264 Annex-B access unit, read off the bytes: where its
 * NAL units are, whether it can start a decode (an IDR), and the `avc1.PPCCLL` codec string its SPS
 * names. Pure, so `h264.test.mjs` pins it without a decoder.
 *
 * The helper (VideoToolbox) emits Annex-B with SPS and PPS in front of every keyframe, so the first
 * keyframe carries everything `VideoDecoder.configure` needs and no `description` is passed: a
 * decoder configured without one reads Annex-B.
 */

/** NAL unit types this file names. */
export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

/** One NAL unit: its type and its bytes WITHOUT the start code (a view, not a copy). */
export interface Nal { type: number; data: Uint8Array }

/** Split an Annex-B buffer on its 3- or 4-byte start codes. Bytes before the first start code
 *  (there should be none) are skipped; an empty unit is dropped. */
export function splitAnnexB(buf: Uint8Array): Nal[] {
  const starts: { at: number; len: number }[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) { starts.push({ at: i, len: 3 }); i += 2; continue; }
      if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1) { starts.push({ at: i, len: 4 }); i += 3; continue; }
    }
  }
  const out: Nal[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k]!.at + starts[k]!.len;
    const to = k + 1 < starts.length ? starts[k + 1]!.at : buf.length;
    if (to <= from) continue;
    const data = buf.subarray(from, to);
    out.push({ type: data[0]! & 0x1f, data });
  }
  return out;
}

/** An access unit a decode can START from: it holds an IDR slice. (The frame header's key flag
 *  says the same; the bytes are the authority when the two disagree.) */
export function isKeyframe(buf: Uint8Array): boolean {
  return splitAnnexB(buf).some((n) => n.type === NAL_IDR);
}

/** The first SPS in the unit, or null. */
export function findSps(buf: Uint8Array): Uint8Array | null {
  return splitAnnexB(buf).find((n) => n.type === NAL_SPS)?.data ?? null;
}

/** The SPS's first bytes with emulation-prevention bytes (`00 00 03`) removed — the three this
 *  file reads are right after the header, where a `03` is rare but legal. */
function rbspHead(sps: Uint8Array, n: number): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 1; i < sps.length && out.length < n; i++) {
    const b = sps[i]!;
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");

/** `avc1.PPCCLL` from an SPS NAL (header byte included): profile_idc, the constraint flags byte,
 *  level_idc. Null when it is not an SPS or too short to say. */
export function codecFromSps(sps: Uint8Array): string | null {
  if (sps.length < 4 || (sps[0]! & 0x1f) !== NAL_SPS) return null;
  const [p, c, l] = rbspHead(sps, 3);
  if (p === undefined || c === undefined || l === undefined) return null;
  return `avc1.${hex2(p)}${hex2(c)}${hex2(l)}`;
}

/** The codec string a keyframe's own SPS names, or null. */
export function codecOf(buf: Uint8Array): string | null {
  const sps = findSps(buf);
  return sps ? codecFromSps(sps) : null;
}

/** The string asked of `VideoDecoder.isConfigSupported` before any frame has arrived: Main@3.1,
 *  what the plan expects VideoToolbox's real-time encoder to produce. */
export const PROBE_CODEC = "avc1.4D401F";
