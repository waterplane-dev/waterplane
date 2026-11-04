/**
 * The DER writer behind `lantls.ts`: exactly the ASN.1 an X.509 certificate needs and
 * nothing more. It writes, it never parses — every reader of its output is
 * `node:crypto`, OpenSSL or a phone's TLS stack, so a mistake here is a refusal there.
 */

/** Definite length, short form under 128, else the fewest bytes that hold it. */
function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One tag-length-value. Context tags go through here too: 0xa0 + n constructed, 0x80 + n primitive. */
export function tlv(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

export const seq = (...parts: Uint8Array[]): Buffer => tlv(0x30, ...parts);
export const set = (...parts: Uint8Array[]): Buffer => tlv(0x31, ...parts);
export const octetString = (b: Uint8Array): Buffer => tlv(0x04, b);
export const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
export const boolTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]));

/** `unused` is how many low bits of the last byte are padding (a named-bit list; 0 for a signature). */
export const bitString = (b: Uint8Array, unused = 0): Buffer => tlv(0x03, Buffer.from([unused]), b);

/** An unsigned big-endian value as a minimal, non-negative INTEGER. */
export function integer(b: Uint8Array): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return v[0] & 0x80 ? tlv(0x02, Buffer.from([0]), v) : tlv(0x02, v);
}

export function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const arc of rest) {
    const groups = [arc % 128];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) groups.unshift(0x80 | (v % 128));
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. Always UTC, to the second. */
export function time(d: Date): Buffer {
  const stamp = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(stamp.slice(2), "ascii")) : tlv(0x18, Buffer.from(stamp, "ascii"));
}
