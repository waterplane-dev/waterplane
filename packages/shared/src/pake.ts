/**
 * Pairing a phone over a network nobody trusts: CPace over ristretto255, keyed by the 8-character
 * pairing code. The phone and the host both run THIS file, so there is one reading of every byte.
 *
 *   phone                                              host
 *   sidP (16 random bytes), a
 *   g  = H2C(lp(S), lp(sidP))                          S = SHA-256(utf8(code)), see below
 *   Ya = a·g               ── start {sidP, ya} ──▶     for each code i it may offer (at most 5):
 *                                                        b_i, Yb_i = b_i·g_i
 *                          ◀── {nh, yb: [Yb_i]} ──
 *   TH_i = SHA-512(lp(DST), lp(sidP), lp(nh), lp(Ya), lp(Yb_i))
 *   Z_i  = a·Yb_i = b_i·Ya
 *   K_phone, K_box, K_seal = HKDF-SHA256(ikm Z_i, salt TH_i, info = the label, 32 bytes each)
 *   confirm_i = HMAC-SHA256(K_phone_i, TH_i)
 *   box_i     = nonce96 ‖ AES-256-GCM(K_box_i, json, aad TH_i)
 *                    ── finish {sidP, confirm, box} ──▶  one confirm of one code, or a miss
 *                          ◀── {seal} ──                 nonce96 ‖ AES-256-GCM(K_seal, json, aad TH)
 *
 * The phone proves first, so a wrong guess is detected and counted by the host; the seal opening is
 * what authenticates the host. A relay gets one online guess per attempt and learns nothing it can
 * test offline: without the code it cannot compute g.
 *
 * **`S`, not the code itself.** The host keeps a code only as its SHA-256 (`PairStore`: no live
 * credential sits in its memory as typed) and the generator depends on the phone's fresh `sidP`, so
 * it cannot be worked out at mint time. Both ends therefore hash first. `S` is one-to-one with the
 * code, so the password space and the guess count are the same as hashing the code directly.
 *
 * **Encodings.** `lp(x)` is a 4-byte big-endian length, then `x`. A code goes in as its normalized
 * form (`normalizePairCode`). Every binary field on the wire is standard padded base64, decoded
 * strictly (`pakeDecode`), so one value has one spelling.
 *
 * `@noble/curves` is loaded by dynamic import, so the phone's main chunk never carries it and it
 * costs nothing until somebody pairs. HKDF, HMAC, AES-GCM and the hashes are WebCrypto, which node
 * and the APK's WebView both have; a plain-http browser page does not, and `PakeFailure` says so.
 */
import { defaultRandomBytes, type RandomBytes } from "./hosts.js";

/** The domain separator: frozen, and not the brand, because both ends of a pairing must agree on it
 *  across a rename. */
// eslint-disable-next-line local/no-brand-literal -- a wire constant, frozen across any rename
export const PAKE_DST = "waterplane-cpace-v1";
/** The most codes a host offers, and the most shares a phone will answer. */
export const PAKE_MAX_OFFERS = 5;
export const PAKE_SID_BYTES = 16;
export const PAKE_NONCE_BYTES = 16;
export const PAKE_POINT_BYTES = 32;
export const PAKE_CONFIRM_BYTES = 32;
export const PAKE_TH_BYTES = 64;
const GCM_NONCE_BYTES = 12;
const KEY_BYTES = 32;

/** A value that cannot be used: a bad point, a malformed field, no WebCrypto. Never a wrong code. */
export class PakeFailure extends Error {}

const text = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

interface Subtle {
  digest(alg: string, data: Bytes): Promise<ArrayBuffer>;
  importKey(format: "raw", key: Bytes, alg: unknown, extractable: false, usages: string[]): Promise<unknown>;
  deriveBits(alg: unknown, key: unknown, bits: number): Promise<ArrayBuffer>;
  sign(alg: string, key: unknown, data: Bytes): Promise<ArrayBuffer>;
  encrypt(alg: unknown, key: unknown, data: Bytes): Promise<ArrayBuffer>;
  decrypt(alg: unknown, key: unknown, data: Bytes): Promise<ArrayBuffer>;
}

function subtle(): Subtle {
  const s = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (!s) throw new PakeFailure("This page has no WebCrypto, so it cannot pair securely. Open it over https or use the app.");
  return s;
}

const own = (b: Uint8Array): Bytes => new Uint8Array(b);

/** `x` with its 4-byte big-endian length in front. */
export function lp(x: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + x.length);
  new DataView(out.buffer).setUint32(0, x.length);
  out.set(x, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Standard padded base64. */
export function pakeEncode(b: Uint8Array): string {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s);
}

/** Strict base64: only the one spelling `pakeEncode` writes, optionally of exactly `len` bytes. */
export function pakeDecode(raw: unknown, len?: number): Uint8Array | null {
  if (typeof raw !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null;
  let bin: string;
  try { bin = atob(raw); } catch { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (pakeEncode(out) !== raw) return null;
  return len === undefined || out.length === len ? out : null;
}

export async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", own(b)));
}

async function sha512(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-512", own(b)));
}

interface Group {
  fromBytes(b: Uint8Array): Point;
  hash(msg: Uint8Array): Point;
  order: bigint;
}
interface Point { multiply(s: bigint): Point; toBytes(): Uint8Array; is0(): boolean }

let group: Promise<Group> | null = null;

function ristretto(): Promise<Group> {
  group ??= import("@noble/curves/ed25519.js").then(({ ristretto255, ristretto255_hasher }) => ({
    fromBytes: (b) => ristretto255.Point.fromBytes(b),
    hash: (msg) => ristretto255_hasher.hashToCurve(msg, { DST: text.encode(PAKE_DST) }),
    order: ristretto255.Point.Fn.ORDER,
  }));
  return group;
}

/** A share off the wire: 32 bytes, a canonical encoding, never the identity. */
async function decodeShare(b: Uint8Array): Promise<Point> {
  if (b.length !== PAKE_POINT_BYTES) throw new PakeFailure("A key share is the wrong length.");
  const g = await ristretto();
  let p: Point;
  try { p = g.fromBytes(b); } catch { throw new PakeFailure("A key share is not a canonical group element."); }
  if (p.is0()) throw new PakeFailure("A key share is the identity element.");
  return p;
}

/** Whether `b` is a share `decodeShare` accepts. */
export async function pakeShareOk(b: Uint8Array): Promise<boolean> {
  try { await decodeShare(b); return true; } catch (e) { if (e instanceof PakeFailure) return false; throw e; }
}

/** What goes in for the code: SHA-256 of its normalized form (the header says why). */
export function pakeSecret(code: string): Promise<Uint8Array> {
  return sha256(text.encode(code));
}

async function randomScalar(rand: RandomBytes): Promise<bigint> {
  const { order } = await ristretto();
  for (;;) {
    // 512 bits reduced mod a 253-bit order: no bias worth naming.
    let n = 0n;
    for (const c of rand(64)) n = (n << 8n) | BigInt(c);
    const s = n % order;
    if (s !== 0n) return s;
  }
}

/** A fresh scalar and its share on the generator for `secret` and `sidP`. */
export async function pakeShare(secret: Uint8Array, sidP: Uint8Array, rand: RandomBytes = defaultRandomBytes): Promise<{ scalar: bigint; share: Uint8Array }> {
  const g = await ristretto();
  const scalar = await randomScalar(rand);
  return { scalar, share: g.hash(concat(lp(secret), lp(sidP))).multiply(scalar).toBytes() };
}

/** `TH`: everything both ends must have seen alike. */
export function pakeTranscript(sidP: Uint8Array, nh: Uint8Array, ya: Uint8Array, yb: Uint8Array): Promise<Uint8Array> {
  return sha512(concat(lp(text.encode(PAKE_DST)), lp(sidP), lp(nh), lp(ya), lp(yb)));
}

/** `Z`: my scalar on the peer's share. Throws on a bad share, and on an identity result. */
export async function pakeSharedPoint(scalar: bigint, peerShare: Uint8Array): Promise<Uint8Array> {
  const z = (await decodeShare(peerShare)).multiply(scalar);
  if (z.is0()) throw new PakeFailure("The shared point is the identity element.");
  return z.toBytes();
}

export type PakeLabel = "K_phone" | "K_box" | "K_seal";

async function hkdf(z: Uint8Array, th: Uint8Array, label: PakeLabel): Promise<Uint8Array> {
  const s = subtle();
  const key = await s.importKey("raw", own(z), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: own(th), info: text.encode(label) }, key, KEY_BYTES * 8));
}

export interface PakeKeys { kPhone: Uint8Array; kBox: Uint8Array; kSeal: Uint8Array }

export async function pakeKeys(z: Uint8Array, th: Uint8Array): Promise<PakeKeys> {
  const [kPhone, kBox, kSeal] = await Promise.all([hkdf(z, th, "K_phone"), hkdf(z, th, "K_box"), hkdf(z, th, "K_seal")]);
  return { kPhone, kBox, kSeal };
}

/** `HMAC-SHA256(K_phone, TH)`: the phone's proof that it holds the code. */
export async function pakeConfirm(kPhone: Uint8Array, th: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  const key = await s.importKey("raw", own(kPhone), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await s.sign("HMAC", key, own(th)));
}

async function encryptJson(k: Uint8Array, th: Uint8Array, value: unknown, rand: RandomBytes): Promise<string> {
  const s = subtle();
  const key = await s.importKey("raw", own(k), "AES-GCM", false, ["encrypt"]);
  const iv = own(rand(GCM_NONCE_BYTES));
  const ct = await s.encrypt({ name: "AES-GCM", iv, additionalData: own(th) }, key, own(text.encode(JSON.stringify(value))));
  return pakeEncode(concat(iv, new Uint8Array(ct)));
}

/** The JSON inside, or null for anything that does not authenticate. */
async function decryptJson(k: Uint8Array, th: Uint8Array, raw: unknown): Promise<unknown> {
  const b = pakeDecode(raw);
  if (!b || b.length <= GCM_NONCE_BYTES) return null;
  const s = subtle();
  const key = await s.importKey("raw", own(k), "AES-GCM", false, ["decrypt"]);
  try {
    const pt = await s.decrypt({ name: "AES-GCM", iv: own(b.subarray(0, GCM_NONCE_BYTES)), additionalData: own(th) }, key, own(b.subarray(GCM_NONCE_BYTES)));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; }
}

/** The phone's words to the host: `{deviceName, presented}`, under `K_box`. */
export const pakeBox = (kBox: Uint8Array, th: Uint8Array, value: unknown, rand: RandomBytes = defaultRandomBytes): Promise<string> => encryptJson(kBox, th, value, rand);
export const pakeOpenBox = (kBox: Uint8Array, th: Uint8Array, raw: unknown): Promise<unknown> => decryptJson(kBox, th, raw);
/** The host's reply, under `K_seal`. A random 96-bit nonce, `TH` as the additional data. */
export const pakeSeal = (kSeal: Uint8Array, th: Uint8Array, value: unknown, rand: RandomBytes = defaultRandomBytes): Promise<string> => encryptJson(kSeal, th, value, rand);
export const pakeOpenSeal = (kSeal: Uint8Array, th: Uint8Array, raw: unknown): Promise<unknown> => decryptJson(kSeal, th, raw);

// ── The host's half ─────────────────────────────────────────────────────

/** One code offered to one attempt: what `finish` needs, and no way back to the code. */
export interface PakeOffer { yb: Uint8Array; th: Uint8Array; confirm: Uint8Array; kBox: Uint8Array; kSeal: Uint8Array }

/** `secret`'s answer to a `start`. Throws `PakeFailure` on a bad `ya`. */
export async function pakeHostOffer(secret: Uint8Array, sidP: Uint8Array, ya: Uint8Array, nh: Uint8Array, rand: RandomBytes = defaultRandomBytes): Promise<PakeOffer> {
  const { scalar, share: yb } = await pakeShare(secret, sidP, rand);
  const z = await pakeSharedPoint(scalar, ya);
  const th = await pakeTranscript(sidP, nh, ya, yb);
  const { kPhone, kBox, kSeal } = await pakeKeys(z, th);
  return { yb, th, confirm: await pakeConfirm(kPhone, th), kBox, kSeal };
}

// ── The phone's half ────────────────────────────────────────────────────

export interface PakePhoneState { sidP: Uint8Array; ya: Uint8Array; scalar: bigint }

/** `code` is normalized (`normalizePairCode`). The state stays on the phone. */
export async function pakePhoneStart(code: string, rand: RandomBytes = defaultRandomBytes): Promise<{ state: PakePhoneState; request: { sidP: string; ya: string } }> {
  const sidP = rand(PAKE_SID_BYTES);
  const { scalar, share: ya } = await pakeShare(await pakeSecret(code), sidP, rand);
  return { state: { sidP, ya, scalar }, request: { sidP: pakeEncode(sidP), ya: pakeEncode(ya) } };
}

/** What opens the seal: one candidate per share, because only the host knows which code hit. */
export interface PakeCandidate { kSeal: Uint8Array; th: Uint8Array }

/**
 * Answer a `start` reply. Throws `PakeFailure` on more shares than a host may offer, on none, and on
 * any bad share, because a host that sends one is not worth a guess. `box` is the words the host
 * needs (`PakeBoxBody`), one copy per candidate.
 */
export async function pakePhoneFinish(
  state: PakePhoneState, reply: { nh: unknown; yb: unknown }, box: unknown, rand: RandomBytes = defaultRandomBytes,
): Promise<{ request: { sidP: string; confirm: string[]; box: string[] }; candidates: PakeCandidate[] }> {
  const nh = pakeDecode(reply.nh, PAKE_NONCE_BYTES);
  if (!nh) throw new PakeFailure("The desktop's reply is malformed.");
  if (!Array.isArray(reply.yb) || reply.yb.length === 0 || reply.yb.length > PAKE_MAX_OFFERS) throw new PakeFailure("The desktop offered the wrong number of key shares.");
  const confirm: string[] = [];
  const boxes: string[] = [];
  const candidates: PakeCandidate[] = [];
  for (const raw of reply.yb) {
    const yb = pakeDecode(raw, PAKE_POINT_BYTES);
    if (!yb) throw new PakeFailure("A key share is malformed.");
    const z = await pakeSharedPoint(state.scalar, yb);
    const th = await pakeTranscript(state.sidP, nh, state.ya, yb);
    const { kPhone, kBox, kSeal } = await pakeKeys(z, th);
    confirm.push(pakeEncode(await pakeConfirm(kPhone, th)));
    boxes.push(await pakeBox(kBox, th, box, rand));
    candidates.push({ kSeal, th });
  }
  return { request: { sidP: pakeEncode(state.sidP), confirm, box: boxes }, candidates };
}

/** Open a seal against every candidate. Null: no candidate opens it, so this was not the host that
 *  knew the code, and nothing in it may be believed. */
export async function pakePhoneOpen(candidates: readonly PakeCandidate[], seal: unknown): Promise<unknown> {
  for (const c of candidates) {
    const v = await pakeOpenSeal(c.kSeal, c.th, seal);
    if (v !== null) return v;
  }
  return null;
}
