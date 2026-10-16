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
 * The base goes through `normalizeHostBase`, so a scanned or pasted link can
 * never aim the app at a `javascript:` or `data:` base.
 */

import { normalizeHostBase } from "./hosturl.js";
import { BRAND, LEGACY } from "./brand.js";
import { randomFromAlphabet, defaultRandomBytes, type RandomBytes } from "./hosts.js";

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
}

export function pairDeepLink(base: string, code: string): string {
  return `${PAIR_SCHEME}://pair?u=${encodeURIComponent(base)}&c=${encodeURIComponent(code)}`;
}

export function pairLandingUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, "")}/pair/${code}`;
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
  return base && code ? { base, code } : null;
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
  /** Plain-HTTP LAN base, when the host has a LAN interface bound. */
  lanBase?: string;
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
  }
}
