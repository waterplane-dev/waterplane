/**
 * Pairing a new phone to a desktop: a short code shown as a QR on a phone that
 * is already trusted, redeemed once by the new one.
 *
 * The code is 8 characters from an alphabet with no look-alikes (no 0/O, 1/I),
 * so it can be typed off a screen as a fallback; it lives `PAIR_TTL_MS` and is
 * spent by its first successful redeem. The QR carries the LANDING URL
 * (`<base>/pair/<code>`, a host-rendered page that offers the web version and
 * the APK); the installed app is reached through the DEEP LINK
 * (`<scheme>://pair?u=<base>&c=<code>`). Both parse to the same `{base, code}`.
 *
 * The deep link may also carry, each additive so a shipped page reads `u` and `c` and ignores them:
 * `s=1` (pair by PAKE only, `pake.ts`; never fall back to a plain redeem), `k=<32 hex>` (`pairCommit`:
 * what the seal must match, so someone who has the code still cannot be this desktop) and
 * `l=<plain LAN base>` (so a phone with no tailnet need not type the address). `u` stays plain, and
 * TLS facts ride only inside the seal: a shipped APK could not reach a TLS address.
 *
 * The base goes through `normalizeHostBase`, so a scanned or pasted link can
 * never aim the app at a `javascript:` or `data:` base.
 */

import { normalizeHostBase } from "./hosturl.js";
import { BRAND, LEGACY } from "./brand.js";
import { randomFromAlphabet, defaultRandomBytes, type RandomBytes } from "./hosts.js";
import { trimEndChars } from "./lineartrim.js";
import { pakeDecode, sha256 } from "./pake.js";

/** 32 characters (a power of two: uniform from a byte), no 0, O, 1 or I. */
export const PAIR_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIR_CODE_LEN = 8;
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_SCHEME = BRAND.pairScheme;
/** Past identities' schemes, newest first: still PARSED (a QR printed by an older
 *  host), never emitted. */
export const LEGACY_PAIR_SCHEMES: readonly string[] = LEGACY.map((l) => l.pairScheme);

export function newPairCode(rand: RandomBytes = defaultRandomBytes): string {
  return randomFromAlphabet(PAIR_ALPHABET, PAIR_CODE_LEN, rand);
}

/** A code as typed: case, spaces and dashes forgiven, anything else refused.
 *  No look-alike is "corrected" — 0/O/1/I are not in the alphabet, so a code
 *  containing one was misread and guessing which letter was meant would spend
 *  a rate-limited attempt on a wrong code. */
export function normalizePairCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (s.length !== PAIR_CODE_LEN) return null;
  for (const ch of s) if (!PAIR_ALPHABET.includes(ch)) return null;
  return s;
}

/** `ABCD-EFGH`, for reading aloud or off a screen. */
export function formatPairCode(code: string): string {
  return code.length === PAIR_CODE_LEN ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export interface PairTarget {
  base: string;
  code: string;
  /** `s=1`: this link pairs by PAKE or not at all. Absent: nobody asked for that. */
  secure?: boolean;
  /** `k=`: what the seal must match (`pairCommit`). */
  commit?: string;
  /** `l=`: the plain LAN base. */
  lan?: string;
}

/** What a deep link adds to `u` and `c`. */
export type PairLinkFacts = Pick<PairTarget, "secure" | "commit" | "lan">;

const PAIR_COMMIT_HEX = 32;

export function pairDeepLink(base: string, code: string, facts: PairLinkFacts = {}): string {
  const extra = [
    facts.secure ? "&s=1" : "",
    facts.commit ? `&k=${facts.commit}` : "",
    facts.lan ? `&l=${encodeURIComponent(facts.lan)}` : "",
  ].join("");
  return `${PAIR_SCHEME}://pair?u=${encodeURIComponent(base)}&c=${encodeURIComponent(code)}${extra}`;
}

const hex = (b: Uint8Array): string => Array.from(b, (c) => c.toString(16).padStart(2, "0")).join("");

function hexBytes(s: string): Uint8Array | null {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) return null;
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/**
 * `k=`: the first 32 hex digits (128 bits) of SHA-256(DER ‖ PIN), lowercase, where DER is the update key's SPKI
 * DER (the base64 of `updateKey`, decoded) and PIN the 32 bytes of the TLS pin (the hex of `tls.spki`,
 * decoded). A desktop with no TLS listener has no PIN, so the hash covers the DER alone. Null when
 * either input is malformed, so a phone reads that as a mismatch and never as a pass. 128 bits because
 * the value is the same for every code of a desktop and a link is shared as text: a shorter one could
 * be ground offline once and reused against any later code.
 */
export async function pairCommit(updateKey: unknown, spki?: unknown): Promise<string | null> {
  const der = pakeDecode(updateKey);
  const pin = spki === undefined ? new Uint8Array(0) : typeof spki === "string" ? hexBytes(spki) : null;
  if (!der || der.length === 0 || !pin || (spki !== undefined && pin.length !== 32)) return null;
  const both = new Uint8Array(der.length + pin.length);
  both.set(der);
  both.set(pin, der.length);
  return hex(await sha256(both)).slice(0, PAIR_COMMIT_HEX);
}

/** The update key's fingerprint (8a): lowercase hex SHA-256 of the SPKI DER. What the desktop prints
 *  beside the code, so the native dialog has something to compare against. */
export async function updateKeyFingerprint(updateKey: unknown): Promise<string | null> {
  const der = pakeDecode(updateKey);
  return der && der.length > 0 ? hex(await sha256(der)) : null;
}

export function pairLandingUrl(base: string, code: string): string {
  return `${trimEndChars(base, "/")}/pair/${code}`;
}

/** Parse `<scheme>://pair?u=<base>&c=<code>` (current or a legacy scheme), or `null`. */
export function parsePairDeepLink(raw: unknown): PairTarget | null {
  if (typeof raw !== "string") return null;
  const schemes = [PAIR_SCHEME, ...LEGACY_PAIR_SCHEMES].map((x) => x.replace(/[^a-z0-9+.-]/gi, "")).join("|");
  const m = new RegExp(`^(?:${schemes})://pair/?\\?(.*)$`, "i").exec(raw.trim());
  if (!m) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(m[1]);
  } catch {
    return null;
  }
  const base = normalizeHostBase(params.get("u") ?? "");
  const code = normalizePairCode(params.get("c"));
  if (!base || !code) return null;
  // A commitment that cannot be read is refused rather than dropped: dropped, it would pass as a
  // link that made no promise.
  const commit = params.get("k");
  if (commit !== null && !new RegExp(`^[0-9a-f]{${PAIR_COMMIT_HEX}}$`).test(commit)) return null;
  const lan = normalizeHostBase(params.get("l") ?? "");
  return {
    base, code,
    ...(params.get("s") === "1" ? { secure: true } : {}),
    ...(commit !== null ? { commit } : {}),
    ...(lan ? { lan } : {}),
  };
}

/** The code in a landing path: `/pair/<code>` (page) or `/pair/<code>/apk`. */
export function pairPathCode(pathname: string): { code: string; apk: boolean } | null {
  const m = /^\/pair\/([^/]+)(\/apk)?\/?$/.exec(pathname);
  if (!m) return null;
  let seg: string;
  try {
    seg = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  const code = normalizePairCode(seg);
  return code ? { code, apk: !!m[2] } : null;
}

/** Parse `<base>/pair/<code>`, or `null`. */
export function parsePairLandingUrl(raw: unknown): PairTarget | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const p = pairPathCode(u.pathname);
  if (!p || p.apk) return null;
  const base = normalizeHostBase(`${u.protocol}//${u.host}`);
  return base ? { base, code: p.code } : null;
}

/** Whatever was scanned or pasted: a deep link or a landing URL. */
export function parsePairInput(raw: unknown): PairTarget | null {
  return parsePairDeepLink(raw) ?? parsePairLandingUrl(raw);
}

export function pairExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

// ── Wire DTOs (HTTP) ──────────────────────────────────────────────────

/** One waterplane daemon found on the tailnet (`GET /api/tailnet/peers`). */
export interface TailnetPeer {
  /** The tailscale hostname. */
  name: string;
  /** `100.x.y.z:port` — what the phone saves as the host's address. */
  addr: string;
  os: string;
  /** The daemon answered 401: it has a password, so a pairing code is needed. */
  gated: boolean;
}

/** `GET /api/tailnet/peers` (trusted path only). `peers` is empty with a
 *  sentence in `note` when tailscale is missing or nobody answered. */
export interface TailnetPeersResponse {
  ok: true;
  peers: TailnetPeer[];
  note?: string;
}

/** `POST /api/pair/mint` (trusted, authenticated caller) → */
/** `POST /api/pair/mint` body. `passive`: the device this code pairs gets a
 *  passive token (`passive.ts`), and redeeming it switches "gate Tailscale" on. */
export interface PairMintRequest {
  passive?: boolean;
}

export interface PairMintResponse {
  code: string;
  /** The code pairs a passive device. */
  passive?: boolean;
  expiresAt: number;
  /** What the QR encodes. */
  landingUrl: string;
  deepLink: string;
  base: string;
  /** Plain-HTTP LAN base, when the host has a LAN interface bound. Equal to `base` on a desktop with
   *  no tailnet, and then `landingUrl` is a plain address: opening it burns the code. */
  lanBase?: string;
  /** The deep link says `s=1`. Absent with no password set, because PAKE refuses every attempt then. */
  secure?: boolean;
  /** The deep link's `k=`. */
  commit?: string;
  /** Lowercase hex SHA-256 of the update key's DER, printed beside the code. */
  updateKeyFingerprint?: string;
  /** The same link with `u=` the LAN address, for a shipped APK that ignores `l=`. Only when `base`
   *  is another address. */
  lanDeepLink?: string;
}

/** `POST /api/pair/redeem` */
export interface PairRedeemRequest {
  code: string;
  deviceName: string;
}

export interface PairRedeemHost {
  name: string;
  base: string;
  httpsUrl: string | null;
  lanBase?: string;
  lanSsids?: string[];
}

/** `no-password`: the host has no password and the redeem came over the LAN —
 *  its `message` is the host's own sentence and is shown verbatim. */
export type PairRedeemError = "bad-request" | "unknown" | "expired" | "used" | "rate-limited" | "no-password";

export type PairRedeemResponse =
  | {
      ok: true;
      host: PairRedeemHost;
      /** Device token (a new ledger row) — absent when no password is set. */
      token?: string;
      deviceId?: string;
      /** Only to a loopback/tailscale peer. */
      lanIdentity?: { hostId: string; secret: string };
      /** A sentence for the phone when it got no token (no password set). */
      note?: string;
      /** The token is a passive one (`passive.ts`). */
      scope?: "passive";
    }
  | { ok: false; error: PairRedeemError; message: string };

// ── PAKE pairing over HTTP (`pake.ts`). Binary fields are base64, `pakeDecode`d strictly. ──

/** `POST /api/pair/pake/start`. Carries no `Authorization`. */
export interface PakeStartRequest {
  sidP: string;
  ya: string;
}

/** `POST /api/pair/pake/finish`, also with no `Authorization`. `confirm[i]` and `box[i]` answer
 *  `yb[i]`; the phone cannot know which code it holds, so it answers all of them. */
export interface PakeFinishRequest {
  sidP: string;
  confirm: string[];
  box: string[];
}

/** What a `box` holds. `presented` is the old token a re-pair retires, sealed so a relay never sees
 *  it, and so it can never ride in a header on these routes. */
export interface PakeBoxBody {
  deviceName: string;
  presented?: string;
}

/**
 * Why a PAKE route refused. `closed`, `no-password` and `no-codes` come from a host that DOES speak
 * PAKE, so a phone never answers them with a plain redeem. `unknown` is a miss; `no-session` is a
 * `finish` with nothing to finish, its 60 seconds up or its one try spent. None of them is a 404,
 * which stays what a host with no PAKE at all may answer.
 */
export type PakeError = PairRedeemError | "closed" | "no-codes" | "no-session";

export type PakeRefusal = { ok: false; error: PakeError; message: string };

export type PakeStartResponse = { ok: true; nh: string; yb: string[] } | PakeRefusal;

export type PakeFinishResponse = { ok: true; seal: string } | PakeRefusal;

/** Inside the seal: `redeemPair`'s answer and what only a sealed reply may carry. The seal opening
 *  proves the host knew the code, which is why the LAN identity may go to a LAN redeemer here. */
export type PakeSealedReply = Extract<PairRedeemResponse, { ok: true }> & {
  hostId: string;
  /** Absent with no TLS listener. `spki` is lowercase hex. */
  tls?: { port: number; spki: string };
  /** Base64 SPKI DER (8a). */
  updateKey?: string;
  lanIdentity: { hostId: string; secret: string };
};

export function pakeErrorText(error: PakeError): string {
  switch (error) {
    case "closed":
      return "Too many wrong attempts closed encrypted pairing for this code. Show a new code on the desktop.";
    case "no-codes":
      return "The desktop has no pairing code showing. Show a new code and try again.";
    case "no-session":
      return "That pairing attempt ran out of time. Try again.";
    default:
      return pairRedeemErrorText(error);
  }
}

export function pairRedeemErrorText(error: PairRedeemError): string {
  switch (error) {
    case "bad-request":
      return "That is not a pairing code — it is 8 letters and digits.";
    case "unknown":
      return "The desktop does not know that code. Check it, or show a new QR.";
    case "expired":
      return "That code has expired (they last 10 minutes). Show a new QR on the paired phone.";
    case "used":
      return "That code was already used. Show a new QR on the paired phone.";
    case "rate-limited":
      return "Too many attempts. Wait a minute and try again.";
    case "no-password":
      return "This desktop has no password set, so it refuses pairing over the Wi-Fi. Pair over Tailscale instead.";
    // `error` is the host's answer: a refusal a newer host adds reaches an
    // older phone with no case for it.
    default:
      return "The desktop refused that code for a reason this app version cannot name. Show a new QR and try again.";
  }
}
