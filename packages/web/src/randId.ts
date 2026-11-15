/**
 * The phone's ONE source of random ids: `crypto.getRandomValues`, never `Math.random`.
 *
 * These ids only keep local records apart (a clip, a pad note, a schedule, a lease
 * holder); none of them guards anything. They come from `crypto` anyway so a scanner
 * (CodeQL js/insecure-randomness) has nothing to flag and nobody has to re-argue that
 * per call site. Not `crypto.randomUUID`: it needs a secure context, and plain
 * `http://100.x` is not one; `getRandomValues` works on any origin.
 *
 * If `crypto` is missing altogether, the fallback is time plus a per-tab counter:
 * still unique within this tab, and still not `Math.random`.
 */

let fallbackSeq = 0;

function bytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  try {
    globalThis.crypto.getRandomValues(a);
  } catch {
    let x = Date.now() + ++fallbackSeq * 0x9e3779b1;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; }
  }
  return a;
}

/** `len` lowercase hex characters (default 8). */
export function randId(len = 8): string {
  const out = Array.from(bytes(Math.ceil(len / 2)), (b) => b.toString(16).padStart(2, "0")).join("");
  return out.slice(0, len);
}

/** A number in [0, 1), the drop-in for `Math.random()` where a fraction is what is wanted. */
export function randUnit(): number {
  const b = bytes(4);
  return ((b[0] << 24 >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]) / 2 ** 32;
}
