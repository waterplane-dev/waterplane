/**
 * Pairing a new phone by QR: the code store, the three routes and the
 * host-rendered landing page.
 *
 *   POST /api/pair/mint              behind the gate (loopback, an ungated
 *                                    Tailscale peer, or a valid token)
 *   POST /api/pair/redeem {code, deviceName}
 *                                    PRE-auth — the code IS the credential —
 *                                    rate-limited per remote IP
 *   POST /api/pair/pake/start, /finish
 *                                    PRE-auth too: the same code over a network
 *                                    nobody trusts (`pairpake.ts`)
 *   GET  /pair/<code>                the landing page the QR opens
 *   GET  /pair/<code>/apk            the Android build, same origin
 *
 * **Codes live in memory only, as their sha256** (`PairStore`): a restart
 * forgets every outstanding code, which costs a person one "show a new QR" and
 * means no file ever holds a live credential. A lookup hashes the presented
 * code and compares it against EVERY entry with `timingSafeEqual`, no early
 * exit. A code lives `PAIR_TTL_MS`, is spent by its first successful REDEEM —
 * viewing the landing page and downloading the APK do NOT spend it, because
 * the new phone does both before it has an app that can redeem — and at most
 * `PAIR_MAX_OUTSTANDING` are live at once (the oldest is dropped by a new mint).
 * A spent or expired code is remembered a little longer only so the phone can
 * be told WHICH it was; it never passes again.
 *
 * **The landing page reveals nothing without a live code.** It is reachable by
 * a brand-new device with no token (static paths are outside the token gate,
 * and over LAN that is the point: the code is the capability), so the code is
 * checked BEFORE anything about this desktop is rendered, and every invalid
 * case — malformed, unknown, expired, spent, rate-limited — is the same plain
 * page. `/pair/*` is NOT in `OPAQUE_READ_ROUTES` and passes no origin check:
 * it is a top-level navigation, not an `/api/` call.
 *
 * **A code never crosses a plain socket and lives.** A code in a request line is read by whoever
 * relays it, who then holds the PAKE secret and can play host. So on a socket that is not loopback,
 * the tailnet, `tailscale serve` or TLS, a live code is BURNED, before the rate limit and the method
 * check, because a relay could spend the limit first and then forward the code. What that socket
 * gets is a page with no deep link, no APK and nothing about this desktop.
 *
 * Redeem mints a device token (a ledger row, `auth.issueToken`) only when a
 * password is set — deny-until-set. With none set a loopback/Tailscale peer
 * needs no token and is told so; a LAN peer is refused BEFORE the code is spent.
 * The LAN identity secret goes only to a loopback/Tailscale redeemer, as
 * `GET /api/lan/identity` does, or under a PAKE seal.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import {
  PAIR_TTL_MS, formatPairCode, newPairCode, normalizeDeviceName, normalizePairCode, pairDeepLink, pairLandingUrl,
  pairPathCode, pairRedeemErrorText, BRAND, releaseApkName,
  type PairLinkFacts, type PairMintResponse, type PairRedeemError, type PairRedeemHost, type PairRedeemResponse, type PeerKind,
} from "@waterplane/shared";
import { tokenFromRequest, type AuthManager } from "./auth.js";
import { lanIdentity } from "./lanid.js";
import type { LanTlsFacts } from "./lantls.js";
import { hostName, isEncryptedSocket, lanIps, requestPeerKind, serveHttpsUrl, tailscaleIp } from "./net.js";
import { PAKE_MISS_CAP, PakeSessions, pairLinkFacts, pakeFinish, pakeStart } from "./pairpake.js";
import { RateLimiter, rateKey } from "./ratelimit.js";
import { corsHeaders } from "./origin.js";
import { env } from "./env.js";

/** Live (unspent, unexpired) codes at once; a mint past it drops the oldest. */
export const PAIR_MAX_OUTSTANDING = 5;
/** A spent/expired code is remembered this long past its expiry, only so the
 *  phone can say "used" or "expired" instead of "unknown". */
const PAIR_FORGET_AFTER_MS = PAIR_TTL_MS;
/** Hard bound on remembered entries (live + spent + expired). */
const PAIR_MAX_ENTRIES = 50;

export type PairState = "ok" | "unknown" | "expired" | "used";

interface Entry { hash: Buffer; createdAt: number; expiresAt: number; mintedBy: string | null; usedAt: number | null; passive: boolean; pakeMisses: number }

/** `WATERPLANE_PAIR_TTL_MS` shortens the lifetime for e2e (floored at 1 s, never
 *  longer than the shared 10 minutes the phone's sentences promise). */
function pairTtlFromEnv(): number {
  const n = Number(env("PAIR_TTL_MS"));
  return Number.isFinite(n) && n > 0 ? Math.min(PAIR_TTL_MS, Math.max(1000, n)) : PAIR_TTL_MS;
}

function hashCode(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

/** `compare` is `timingSafeEqual` — a seam only so a test can COUNT the
 *  comparisons a lookup makes (every entry, whatever matched first). */
export interface PairStoreOpts { now?: () => number; ttlMs?: number; maxOutstanding?: number; compare?: (a: Buffer, b: Buffer) => boolean }

export class PairStore {
  private entries: Entry[] = [];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxOutstanding: number;
  private readonly compare: (a: Buffer, b: Buffer) => boolean;
  /** The PAKE attempts under way: memory only, and derived from the codes, so they live beside them. */
  readonly pake: PakeSessions;

  constructor(opts: PairStoreOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? pairTtlFromEnv();
    this.maxOutstanding = opts.maxOutstanding ?? PAIR_MAX_OUTSTANDING;
    this.compare = opts.compare ?? timingSafeEqual;
    this.pake = new PakeSessions({ now: this.now });
  }

  /** A new code; the plaintext exists only in the return value. */
  mint(mintedBy: string | null, passive = false): { code: string; expiresAt: number } {
    const now = this.now();
    this.prune(now);
    let code = newPairCode();
    while (this.find(code) !== null) code = newPairCode(); // 32^8: never in practice
    const live = this.entries.filter((e) => e.usedAt === null && e.expiresAt > now);
    for (let i = 0; i <= live.length - this.maxOutstanding; i++) this.entries.splice(this.entries.indexOf(live[i]!), 1);
    const expiresAt = now + this.ttlMs;
    this.entries.push({ hash: hashCode(code), createdAt: now, expiresAt, mintedBy, usedAt: null, passive, pakeMisses: 0 });
    while (this.entries.length > PAIR_MAX_ENTRIES) this.entries.shift();
    return { code, expiresAt };
  }

  private find(code: string): Entry | null {
    return this.findHash(hashCode(code));
  }

  /** Constant-time over every entry: no early exit on a match. */
  private findHash(h: Buffer): Entry | null {
    let hit: Entry | null = null;
    for (const e of this.entries) if (this.compare(e.hash, h) && hit === null) hit = e;
    return hit;
  }

  private stateOf(e: Entry | null, now: number): PairState {
    if (!e) return "unknown";
    if (e.usedAt !== null) return "used";
    return now >= e.expiresAt ? "expired" : "ok";
  }

  /** What a code is, spending nothing (the landing page, the APK). */
  peek(code: string): PairState {
    return this.peekHash(hashCode(code));
  }

  peekHash(hash: Buffer): PairState {
    const now = this.now();
    this.prune(now);
    return this.stateOf(this.findHash(hash), now);
  }

  /** Does this code pair a passive device? Spends nothing. */
  isPassive(code: string): boolean {
    return this.isPassiveHash(hashCode(code));
  }

  isPassiveHash(hash: Buffer): boolean {
    return this.findHash(hash)?.passive === true;
  }

  /** Spend a live code. Anything but "ok" spends nothing. */
  redeem(code: string): { state: PairState; mintedBy: string | null; passive: boolean } {
    return this.redeemHash(hashCode(code));
  }

  redeemHash(hash: Buffer): { state: PairState; mintedBy: string | null; passive: boolean } {
    const now = this.now();
    this.prune(now);
    const e = this.findHash(hash);
    const state = this.stateOf(e, now);
    if (state === "ok" && e) e.usedAt = now;
    return { state, mintedBy: e?.mintedBy ?? null, passive: e?.passive === true };
  }

  /** A live code crossed a plain socket: spent, for nobody. True when it was live. */
  burn(code: string): boolean {
    return this.redeem(code).state === "ok";
  }

  /** The live codes, and the hashes of those PAKE may still offer. */
  pakeCodes(): { live: number; open: Buffer[] } {
    const now = this.now();
    this.prune(now);
    const live = this.entries.filter((e) => e.usedAt === null && e.expiresAt > now);
    return { live: live.length, open: live.filter((e) => e.pakeMisses < PAKE_MISS_CAP).map((e) => e.hash) };
  }

  /** One wrong confirm against each of these codes. Closes a code for PAKE, never for redeem. */
  pakeMiss(hashes: readonly Buffer[]): void {
    for (const h of hashes) {
      const e = this.findHash(h);
      if (e) e.pakeMisses += 1;
    }
  }

  /** The one comparison of secrets here, for `pairpake.ts`'s confirms. */
  readonly compareHash = (a: Buffer, b: Buffer): boolean => this.compare(a, b);

  /** Live codes right now. */
  outstanding(): number {
    const now = this.now();
    return this.entries.filter((e) => e.usedAt === null && e.expiresAt > now).length;
  }

  /** Every remembered entry, spent and expired included (tests). */
  get size(): number { return this.entries.length; }

  /** The stored hashes, hex (tests: nothing at rest is the code). */
  storedHashes(): string[] { return this.entries.map((e) => e.hash.toString("hex")); }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now < e.expiresAt + PAIR_FORGET_AFTER_MS);
  }
}

// ── Where this desktop is reachable ─────────────────────────────────────

export interface PairNet {
  name: string;
  /** The tailnet base: the https serve URL when discovered, else http://<tailscale IP>:port. With
   *  no tailnet, the plain LAN base: never loopback a phone cannot reach, and never the TLS address,
   *  which a shipped APK could not reach either. */
  base: string;
  httpsUrl: string | null;
  /** Plain-HTTP LAN base, only when a LAN interface is bound (`WATERPLANE_ALLOW_PUBLIC=1`). */
  lanBase?: string;
}

let netCache: { at: number; port: number; net: PairNet } | null = null;
const NET_CACHE_MS = 60_000;

/**
 * Re-derived here rather than handed down from `main()`: the same three facts
 * `main()` binds with (tailscale IP, serve URL, bound LAN IPs), asked of the
 * same functions, cached a minute — a mint is a person tapping "show QR", not
 * a hot path. An explicit `WATERPLANE_HOST` is the address actually bound, so it
 * wins over the Tailscale IP.
 */
export async function pairNet(port: number): Promise<PairNet> {
  const now = Date.now();
  if (netCache && netCache.port === port && now - netCache.at < NET_CACHE_MS) return netCache.net;
  const net = pairNetFrom({
    port, name: hostName(), httpsUrl: await serveHttpsUrl(port), tailscale: await tailscaleIp(),
    hostEnv: env("HOST"), allowPublic: env("ALLOW_PUBLIC") === "1", lanIps: lanIps(),
  });
  netCache = { at: now, port, net };
  return net;
}

/** `pairNet`'s decision over the facts it asked for. Pure. Loopback is left only when nothing else
 *  is bound, and then no phone is reachable anyway. */
export function pairNetFrom(i: { port: number; name: string; httpsUrl: string | null; tailscale: string | null; hostEnv: string | undefined; allowPublic: boolean; lanIps: readonly string[] }): PairNet {
  const explicit = i.hostEnv && !/^(0\.0\.0\.0|::)$/.test(i.hostEnv) ? i.hostEnv : null;
  const lan = i.allowPublic && !explicit ? i.lanIps[0] : undefined;
  const addr = explicit ?? i.tailscale ?? lan ?? "127.0.0.1";
  const hostPart = addr.includes(":") ? `[${addr}]` : addr;
  return {
    name: i.name,
    base: i.httpsUrl ?? `http://${hostPart}:${i.port}`,
    httpsUrl: i.httpsUrl,
    ...(lan ? { lanBase: `http://${lan}:${i.port}` } : {}),
  };
}

// ── The Android build ───────────────────────────────────────────────────

/** Gradle's output for `npm run apk` — the `dev` flavor's debug build, the
 *  owner's sideloadable one (the `play` flavor ships through Google Play and is
 *  never handed out here) — relative to this checkout (`src/` under tsx and
 *  `dist/` built are both one level under `packages/host`). */
export const DEFAULT_APK = resolve(import.meta.dirname, "../../app/android/app/build/outputs/apk/dev/debug/app-dev-debug.apk");

export interface ApkFile { path: string; size: number; mtimeMs: number }

function apkAt(p: string): ApkFile | null {
  try {
    const st = statSync(p);
    if (st.isFile()) return /\.apk$/i.test(p) && st.size > 0 ? { path: p, size: st.size, mtimeMs: st.mtimeMs } : null;
    if (!st.isDirectory()) return null;
    let best: ApkFile | null = null;
    for (const name of readdirSync(p)) {
      if (!/\.apk$/i.test(name)) continue;
      const f = apkAt(join(p, name));
      if (f && (!best || f.mtimeMs > best.mtimeMs)) best = f;
    }
    return best;
  } catch { return null; }
}

/** The newest of `WATERPLANE_APK_PATH` (a file, or a directory of .apk files) and
 *  the default gradle output; null when neither holds one. */
export function latestApk(envPath = env("APK_PATH"), fallback = DEFAULT_APK): ApkFile | null {
  const cands = [envPath ? apkAt(envPath) : null, apkAt(fallback)].filter((x): x is ApkFile => !!x);
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cands[0] ?? null;
}

/** The install root's `release.json`: `dist/` → `host/` → `packages/` → the root. */
const RELEASE_JSON = resolve(import.meta.dirname, "../../../release.json");

/**
 * Where a release install's phone can get the APK, or null. Never a guess: a URL
 * is built only from what the release says it published (`apk`, the asset's file
 * name, which `scripts/release/build.mjs --apk` records), or an explicit
 * `WATERPLANE_APK_URL` (https only). A release without an APK asset answers null,
 * and the page then says the web route — a link that 404s is worse than none.
 */
export function releaseApkUrl(
  releaseJson: unknown = readJsonQuiet(RELEASE_JSON),
  envUrl = env("APK_URL"),
  org = BRAND.githubOrg,
  slug = BRAND.slug,
): string | null {
  if (envUrl && /^https:\/\/[^\s"'<>]+$/.test(envUrl)) return envUrl;
  const r = releaseJson as { version?: unknown; apk?: unknown } | null;
  if (!r || typeof r.version !== "string" || typeof r.apk !== "string") return null;
  if (!/^[\w.-]+\.apk$/i.test(r.apk) || !/^[\w.+-]+$/.test(r.version)) return null;
  if (r.apk !== releaseApkName(slug, r.version)) return null; // the one shared naming rule (shared/brand.ts)
  if (r.apk !== releaseApkName(slug, r.version)) return null; // the one shared naming rule (shared/brand.ts)
  return `https://github.com/${org}/${slug}/releases/download/v${r.version}/${r.apk}`;
}

function readJsonQuiet(p: string): unknown {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export type ApkSource =
  | { kind: "local"; apk: ApkFile }
  | { kind: "release"; url: string }
  | { kind: "none" };

/** The one decision: a build on this computer wins (it matches this host); else the release's; else none. */
export function apkSource(local: ApkFile | null, releaseUrl: string | null): ApkSource {
  if (local) return { kind: "local", apk: local };
  if (releaseUrl) return { kind: "release", url: releaseUrl };
  return { kind: "none" };
}

/** The name a download carries: the build's own time, so two are told apart. */
export function apkFileName(a: ApkFile): string {
  const d = new Date(a.mtimeMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${BRAND.slug}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.apk`;
}

// ── Routes ──────────────────────────────────────────────────────────────

export interface PairDeps {
  root: string;
  port: number;
  auth: AuthManager;
  store: PairStore;
  net(): Promise<PairNet>;
  apk(): ApkFile | null;
  /** The Tailscale gate just switched on (a passive redeem): re-check the open sockets, as `auth.gateTailscale` does. */
  onGateChange?(): void;
  /** The TLS listener's facts; absent means ask `lanTlsFacts()`. A seam for tests. */
  tls?(): LanTlsFacts | null;
}

/** 5 attempts in a burst, then one every 10 s, per remote IP: 32^8 codes do
 *  not fall to that, and a person mistyping twice is never blocked. */
export const redeemLimit = new RateLimiter({ burst: 5, perSec: 0.1 });
/** The landing + APK: a phone loads the page, maybe twice, and the APK once. */
export const landingLimit = new RateLimiter({ burst: 12, perSec: 0.2 });
/** PAKE, like redeem: a `start` and a `finish` per attempt, one bucket each. */
export const pakeStartLimit = new RateLimiter({ burst: 5, perSec: 0.1 });
export const pakeFinishLimit = new RateLimiter({ burst: 5, perSec: 0.1 });

/** Why a redeem was refused, with the host-only case the shared union lacks. */
export type PairRedeemRefusal = PairRedeemError | "no-password";
/** The redeem answer as sent: the shared shape, plus `note` (a sentence for
 *  the phone when it got no token) and the host-only refusal. */
export type PairRedeemReply =
  | (Extract<PairRedeemResponse, { ok: true }> & { note?: string })
  | { ok: false; error: PairRedeemRefusal; message: string };

const NO_PASSWORD_LAN = "This desktop has no password set, so it refuses every device on the Wi-Fi. Pair over Tailscale, or set a password on the paired phone first.";
const NO_PASSWORD_PASSIVE = "This desktop has no password set, and a passive device needs a token of its own. Set a password on the desktop first, then show a new code.";
const NO_PASSWORD_NOTE = "This desktop has no password set, so this phone needs no token over Tailscale. It cannot use the Wi-Fi route until a password is set.";

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(req.headers), ...extra });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) { req.destroy(); return {}; }
    chunks.push(c as Buffer);
  }
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

const refuse = (error: PairRedeemRefusal, message = error === "no-password" ? NO_PASSWORD_LAN : pairRedeemErrorText(error)): PairRedeemReply =>
  ({ ok: false, error, message });

/** The redeem decision, over a store and an auth manager — no sockets, so the
 *  test suite asks it directly. Never spends the code on a refusal.
 *
 *  `presented`: a token the caller sent with the redeem (the phone re-pairing a
 *  desktop it already holds a token for). A valid one names the caller's OWN
 *  old ledger row, which the new token replaces — otherwise every re-pair left
 *  a ghost row in Paired devices. Only the holder of a token can retire it,
 *  and only after the code checked out and a new row was minted. */
export async function redeemPair(
  body: Record<string, unknown>, kind: PeerKind, deps: Pick<PairDeps, "root" | "auth" | "store" | "net" | "onGateChange">, presented: string | null = null,
): Promise<{ status: number; body: PairRedeemReply }> {
  const code = normalizePairCode(body.code);
  if (!code) return { status: 400, body: refuse("bad-request") };
  return redeemHash(hashCode(code), body.deviceName, kind, deps, presented);
}

/** `redeemPair` past the code's own format: the one way a code is spent for a device, which PAKE
 *  reaches with the hash it matched. */
async function redeemHash(
  hash: Buffer, deviceName: unknown, kind: PeerKind, deps: Pick<PairDeps, "root" | "auth" | "store" | "net" | "onGateChange">, presented: string | null,
): Promise<{ status: number; body: PairRedeemReply }> {
  const trustedPath = kind === "loopback" || kind === "tailscale";
  const state = deps.store.peekHash(hash);
  if (state !== "ok") return { status: state === "unknown" ? 404 : 410, body: refuse(state) };
  if (!deps.auth.isEnabled() && !trustedPath) return { status: 403, body: refuse("no-password") };
  // A passive device without a token would be a full one on Tailscale: refused, code unspent.
  if (!deps.auth.isEnabled() && deps.store.isPassiveHash(hash)) return { status: 403, body: refuse("no-password", NO_PASSWORD_PASSIVE) };
  const spent = deps.store.redeemHash(hash);
  if (spent.state !== "ok") return { status: 410, body: refuse("used") };
  const net = await deps.net();
  const host: PairRedeemHost = { name: net.name, base: net.base, httpsUrl: net.httpsUrl, ...(net.lanBase ? { lanBase: net.lanBase } : {}) };
  const out: PairRedeemReply = { ok: true, host };
  if (deps.auth.isEnabled()) {
    const gateBefore = deps.auth.gateTailscale();
    const { token, deviceId } = deps.auth.issueToken(normalizeDeviceName(deviceName) ?? "paired phone", kind, spent.passive ? "passive" : undefined);
    out.token = token;
    out.deviceId = deviceId;
    if (spent.passive) out.scope = "passive";
    if (presented && deps.auth.deviceFor(presented)) deps.auth.revoke(presented);
    // A passive row switches the gate on for good: every tokenless Tailscale socket open right
    // now is no longer authorized, and must be told and closed rather than left to have its
    // frames dropped in silence.
    if (deps.auth.gateTailscale() !== gateBefore) deps.onGateChange?.();
  } else {
    out.note = NO_PASSWORD_NOTE;
  }
  if (trustedPath) {
    const id = lanIdentity(deps.root);
    out.lanIdentity = { hostId: id.hostId, secret: id.secret };
  }
  return { status: 200, body: out };
}

/** `start` or `finish`, past the socket: no header is read, the `box` carries `presented`. */
export function pakeRoute(path: "start" | "finish", body: Record<string, unknown>, kind: PeerKind, deps: PairDeps): ReturnType<typeof pakeStart> | ReturnType<typeof pakeFinish> {
  if (path === "start") return pakeStart(body, deps);
  return pakeFinish(body, deps, (hash, deviceName, presented) => redeemHash(hash, deviceName, kind, deps, presented));
}

/** `POST /api/pair/pake/*`. Sized for five boxes; a redeem's `readJson` default is not. */
async function handlePake(req: IncomingMessage, res: ServerResponse, which: "start" | "finish", kind: PeerKind, deps: PairDeps): Promise<void> {
  const limit = which === "start" ? pakeStartLimit : pakeFinishLimit;
  const key = rateKey(req);
  if (!limit.take(key)) {
    reply(req, res, 429, refuse("rate-limited"), { "retry-after": String(Math.ceil(limit.retryAfterMs(key) / 1000) || 1) });
    return;
  }
  const r = await pakeRoute(which, await readJson(req, 16384), kind, deps);
  reply(req, res, r.status, r.body);
}

/** `POST /api/pair/redeem` and `/api/pair/pake/*`, before the auth gate. True when it answered. */
export async function handlePairPreAuth(req: IncomingMessage, res: ServerResponse, kind: PeerKind, deps: PairDeps): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  const pake = path === "/api/pair/pake/start" ? "start" : path === "/api/pair/pake/finish" ? "finish" : null;
  if (path !== "/api/pair/redeem" && !pake) return false;
  if (req.method !== "POST") { reply(req, res, 405, { error: "POST only" }); return true; }
  if (pake) { await handlePake(req, res, pake, kind, deps); return true; }
  const key = rateKey(req);
  if (!redeemLimit.take(key)) {
    reply(req, res, 429, refuse("rate-limited"), { "retry-after": String(Math.ceil(redeemLimit.retryAfterMs(key) / 1000) || 1) });
    return true;
  }
  const r = await redeemPair(await readJson(req), kind, deps, tokenFromRequest(req.headers));
  reply(req, res, r.status, r.body);
  return true;
}

/** `POST /api/pair/mint`, behind the auth gate. True when it answered. */
export async function handlePairAuthed(req: IncomingMessage, res: ServerResponse, tok: string | null, deps: PairDeps, kind: PeerKind): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== "/api/pair/mint") return false;
  if (req.method !== "POST") { reply(req, res, 405, { error: "POST only" }); return true; }
  // Pairing hands out a full token: only the trusted path (loopback / Tailscale) mints, never a LAN token.
  if (!deps.auth.canManage(kind)) { reply(req, res, 403, { error: "Pairing codes are made from the desktop or from a phone over Tailscale — not over the Wi-Fi route." }); return true; }
  const passive = (await readJson(req)).passive === true;
  if (passive && !deps.auth.isEnabled()) { reply(req, res, 409, { error: NO_PASSWORD_PASSIVE }); return true; }
  const { code, expiresAt } = deps.store.mint(deps.auth.deviceFor(tok)?.id ?? null, passive);
  const net = await deps.net();
  const { link, fingerprint } = await pairLinkFacts(deps, net);
  const { lan, ...overLan } = link;
  const out: PairMintResponse = {
    code, expiresAt, base: net.base, ...(passive ? { passive } : {}),
    landingUrl: pairLandingUrl(net.base, code),
    deepLink: pairDeepLink(net.base, code, link),
    ...(net.lanBase ? { lanBase: net.lanBase } : {}),
    ...(link.secure ? { secure: true } : {}),
    ...(link.commit ? { commit: link.commit } : {}),
    ...(fingerprint ? { updateKeyFingerprint: fingerprint } : {}),
    ...(lan ? { lanDeepLink: pairDeepLink(lan, code, overLan) } : {}),
  };
  reply(req, res, 200, out);
  return true;
}

// ── The landing page ────────────────────────────────────────────────────

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // The code is in the URL: never hand it to another site as a Referer.
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as Record<string, string>;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// lucide-style strokes, inline: no icon font, no external request.
const svg = (d: string) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON_GLOBE = svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>');
const ICON_DOWNLOAD = svg('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>');
const ICON_PHONE = svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>');

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1b1b1a;--muted:#5d5d58;--card:#fff;--line:#deded8;--accent:#2f5bd3;--accentfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--card:#1f1f1d;--line:#34342f;--accent:#7d9bff;--accentfg:#0d0d0c}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;margin:0 auto;padding:24px 16px 40px}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 4px}
p{margin:8px 0}.muted{color:var(--muted);font-size:.93rem}
.choice{display:flex;align-items:center;gap:12px;width:100%;min-height:56px;margin:14px 0 4px;padding:14px 16px;border-radius:12px;background:var(--accent);color:var(--accentfg);text-decoration:none;font-weight:600;font-size:1.05rem}
.choice.alt{background:var(--card);color:var(--fg);border:1px solid var(--line)}
.box{margin-top:24px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
code{font:600 1.05rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
a{color:var(--accent)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** Every invalid case renders THIS — nothing about the desktop in it. */
export function invalidPage(): string {
  return page("Pairing code not valid", `<h1>This pairing code is not valid</h1><p>It may have expired (codes last 10 minutes), already been used, or been mistyped.</p><p>Ask for a new code on your other phone: in ${BRAND.name}, open the host list and choose "show QR".</p>`);
}

/** A code that came over a plain socket: what it gets instead of the landing page. It says nothing
 *  about this desktop, offers no deep link and no APK, and the code in the URL is already dead. */
export function plainSocketPage(): string {
  return page("Pairing code used up", `<h1>This pairing code is now used up</h1><p>It came over an unprotected connection, where anyone on the network could read it, so the desktop cancelled it.</p><p>Show a new code on the desktop and scan it from the desktop's screen with this phone's camera, with the ${BRAND.name} app installed. Scanning never sends the code over the network.</p><p class="muted">No app yet? Get it from Google Play or the release page first, then scan.</p>`);
}

/** Whether a code may cross this request's socket: the one reading of `requestPeerKind` for it.
 *  `lan`, `public` (a Funnel request is one) and `unknown` are plain unless the socket is TLS. */
export function codeMayCross(kind: PeerKind, socket: object): boolean {
  return kind === "loopback" || kind === "tailscale" || isEncryptedSocket(socket);
}

/** The page for a live code. Pure: tests render it without a server. */
export function landingPage(code: string, net: PairNet, apk: ApkFile | null, releaseUrl: string | null = null, link: PairLinkFacts = {}): string {
  const addr = net.base;
  // The PWA route is the URL itself, in words, not only a button: a phone that will never take the
  // APK (an iPhone, a locked-down Android) needs the address to open, bookmark or type.
  const webUrl = `${net.httpsUrl ?? addr}/`;
  const route = `<p class="muted">Or open <code>${esc(webUrl)}</code> in this phone's browser — that is the whole app, no install needed${net.httpsUrl ? "; add it to the home screen to keep it" : ""}.</p>`;
  const web = net.httpsUrl
    ? `<a class="choice" href="${esc(webUrl)}">${ICON_GLOBE}<span>Use web version</span></a>
       ${route}`
    : `<a class="choice" href="${esc(webUrl)}">${ICON_GLOBE}<span>Use web version</span></a>
       ${route}
       <p class="muted">This address is plain http, so the browser will not install the app or show notifications. On the desktop, run <code>tailscale serve --bg --https=443 http://127.0.0.1:${esc(new URL(addr).port || "8770")}</code> to give it an https address.</p>`;
  const mb = apk ? Math.max(1, Math.round(apk.size / 1048576)) : 0;
  const src = apkSource(apk, releaseUrl);
  const app = src.kind === "release"
    ? `<a class="choice alt" href="${esc(src.url)}" rel="noreferrer">${ICON_DOWNLOAD}<span>Download the Android app</span></a>
       <p class="muted">From the ${esc(BRAND.name)} release page. Android will ask to allow installs from your browser.</p>`
    : apk
    ? `<a class="choice alt" href="/pair/${esc(code)}/apk" download="${esc(apkFileName(apk))}">${ICON_DOWNLOAD}<span>Download the Android app</span></a>
       <p class="muted">${mb} MB, built ${esc(new Date(apk.mtimeMs).toISOString().slice(0, 10))}. Android will ask to allow installs from your browser.</p>`
    : `<p class="box">No Android app is offered from this computer. Use the web version${net.httpsUrl ? " — it installs to the home screen" : ""}.</p>`;
  const deep = pairDeepLink(addr, code, link);
  const reach = net.lanBase === net.base ? "This phone must be on the same network as this desktop." : "This phone must be on the same tailnet, with Tailscale connected.";
  return page(`Pair with ${net.name}`, `
<h1>Connect to ${esc(net.name)}</h1>
<p class="muted">${reach}</p>
${web}
${app}
<div class="box">
  <p>${ICON_PHONE} <strong>After installing</strong></p>
  <p>Open the app, choose "Pair with code", enter</p>
  <p><code>${esc(addr)}</code></p>
  <p>and code <code>${esc(formatPairCode(code))}</code></p>
  <p><a href="${esc(deep)}">Open in app</a></p>
  <p class="muted">The code works once and expires 10 minutes after it was shown.</p>
</div>`);
}

/** `GET /pair/<code>` and `/pair/<code>/apk`. Every other `/pair…` path is
 *  the invalid page, never the SPA shell. */
export async function handlePairPage(req: IncomingMessage, res: ServerResponse, deps: PairDeps): Promise<void> {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0];
  const p = pairPathCode(path);
  // First of all: the code has crossed the socket by now, whatever this request turns out to be.
  const burned = !!p && !codeMayCross(requestPeerKind(req.socket.remoteAddress, req.headers), req.socket) && deps.store.burn(p.code);
  if (method !== "GET" && method !== "HEAD") { res.writeHead(405, { ...PAGE_HEADERS, allow: "GET, HEAD" }); res.end(); return; }
  const invalid = (status: number) => { res.writeHead(status, PAGE_HEADERS); res.end(method === "HEAD" ? undefined : invalidPage()); };
  if (!landingLimit.take(rateKey(req))) { invalid(429); return; }
  if (burned) {
    res.writeHead(403, PAGE_HEADERS);
    res.end(method === "HEAD" ? undefined : plainSocketPage());
    return;
  }
  // The code is checked BEFORE anything about this desktop is looked up.
  if (!p || deps.store.peek(p.code) !== "ok") { invalid(404); return; }
  const apk = deps.apk();
  if (p.apk) {
    if (!apk) {
      res.writeHead(404, PAGE_HEADERS);
      res.end(method === "HEAD" ? undefined : page("No Android build", `<h1>No Android build on this computer yet</h1><p>Use the web version instead.</p>`));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": String(apk.size),
      "content-disposition": `attachment; filename="${apkFileName(apk)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (method === "HEAD") { res.end(); return; }
    const s = createReadStream(apk.path);
    s.on("error", () => res.destroy());
    s.pipe(res);
    return;
  }
  const net = await deps.net();
  const html = landingPage(p.code, net, apk, releaseApkUrl(), (await pairLinkFacts(deps, net)).link);
  res.writeHead(200, PAGE_HEADERS);
  res.end(method === "HEAD" ? undefined : html);
}
