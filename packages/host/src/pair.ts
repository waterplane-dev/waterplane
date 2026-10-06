/**
 * Pairing a new phone by QR: the code store, the three routes and the
 * host-rendered landing page.
 *
 *   POST /api/pair/mint              behind the gate (loopback, an ungated
 *                                    Tailscale peer, or a valid token)
 *   POST /api/pair/redeem {code, deviceName}
 *                                    PRE-auth — the code IS the credential —
 *                                    rate-limited per remote IP
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
 * Redeem mints a device token (a ledger row, `auth.issueToken`) only when a
 * password is set — deny-until-set. With none set a loopback/Tailscale peer
 * needs no token and is told so; a LAN peer is refused BEFORE the code is spent.
 * The LAN identity secret goes only to a loopback/Tailscale redeemer, as
 * `GET /api/lan/identity` does.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import {
  PAIR_TTL_MS, formatPairCode, newPairCode, normalizeDeviceName, normalizePairCode, pairDeepLink, pairLandingUrl,
  pairPathCode, pairRedeemErrorText, BRAND, releaseApkName,
  type PairMintResponse, type PairRedeemError, type PairRedeemHost, type PairRedeemResponse, type PeerKind,
} from "@waterplane/shared";
import { tokenFromRequest, type AuthManager } from "./auth.js";
import { lanIdentity } from "./lanid.js";
import { hostName, lanIps, serveHttpsUrl, tailscaleIp } from "./net.js";
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

interface Entry { hash: Buffer; createdAt: number; expiresAt: number; mintedBy: string | null; usedAt: number | null }

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

  constructor(opts: PairStoreOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? pairTtlFromEnv();
    this.maxOutstanding = opts.maxOutstanding ?? PAIR_MAX_OUTSTANDING;
    this.compare = opts.compare ?? timingSafeEqual;
  }

  /** A new code; the plaintext exists only in the return value. */
  mint(mintedBy: string | null): { code: string; expiresAt: number } {
    const now = this.now();
    this.prune(now);
    let code = newPairCode();
    while (this.find(code) !== null) code = newPairCode(); // 32^8: never in practice
    const live = this.entries.filter((e) => e.usedAt === null && e.expiresAt > now);
    for (let i = 0; i <= live.length - this.maxOutstanding; i++) this.entries.splice(this.entries.indexOf(live[i]!), 1);
    const expiresAt = now + this.ttlMs;
    this.entries.push({ hash: hashCode(code), createdAt: now, expiresAt, mintedBy, usedAt: null });
    while (this.entries.length > PAIR_MAX_ENTRIES) this.entries.shift();
    return { code, expiresAt };
  }

  /** Constant-time over every entry: no early exit on a match. */
  private find(code: string): Entry | null {
    const h = hashCode(code);
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
    const now = this.now();
    this.prune(now);
    return this.stateOf(this.find(code), now);
  }

  /** Spend a live code. Anything but "ok" spends nothing. */
  redeem(code: string): { state: PairState; mintedBy: string | null } {
    const now = this.now();
    this.prune(now);
    const e = this.find(code);
    const state = this.stateOf(e, now);
    if (state === "ok" && e) e.usedAt = now;
    return { state, mintedBy: e?.mintedBy ?? null };
  }

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
  /** The tailnet base: the https serve URL when discovered, else http://<tailscale IP>:port. */
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
  const httpsUrl = await serveHttpsUrl(port);
  const ts = await tailscaleIp();
  const hostEnv = env("HOST");
  const explicit = hostEnv && !/^(0\.0\.0\.0|::)$/.test(hostEnv) ? hostEnv : null;
  const addr = explicit ?? ts ?? "127.0.0.1";
  const hostPart = addr.includes(":") ? `[${addr}]` : addr;
  const lan = env("ALLOW_PUBLIC") === "1" && !explicit ? lanIps()[0] : undefined;
  const net: PairNet = {
    name: hostName(),
    base: httpsUrl ?? `http://${hostPart}:${port}`,
    httpsUrl,
    ...(lan ? { lanBase: `http://${lan}:${port}` } : {}),
  };
  netCache = { at: now, port, net };
  return net;
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
}

/** 5 attempts in a burst, then one every 10 s, per remote IP: 32^8 codes do
 *  not fall to that, and a person mistyping twice is never blocked. */
export const redeemLimit = new RateLimiter({ burst: 5, perSec: 0.1 });
/** The landing + APK: a phone loads the page, maybe twice, and the APK once. */
export const landingLimit = new RateLimiter({ burst: 12, perSec: 0.2 });

/** Why a redeem was refused, with the host-only case the shared union lacks. */
export type PairRedeemRefusal = PairRedeemError | "no-password";
/** The redeem answer as sent: the shared shape, plus `note` (a sentence for
 *  the phone when it got no token) and the host-only refusal. */
export type PairRedeemReply =
  | (Extract<PairRedeemResponse, { ok: true }> & { note?: string })
  | { ok: false; error: PairRedeemRefusal; message: string };

const NO_PASSWORD_LAN = "This desktop has no password set, so it refuses every device on the Wi-Fi. Pair over Tailscale, or set a password on the paired phone first.";
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
  body: Record<string, unknown>, kind: PeerKind, deps: Pick<PairDeps, "root" | "auth" | "store" | "net">, presented: string | null = null,
): Promise<{ status: number; body: PairRedeemReply }> {
  const code = normalizePairCode(body.code);
  if (!code) return { status: 400, body: refuse("bad-request") };
  const trustedPath = kind === "loopback" || kind === "tailscale";
  const state = deps.store.peek(code);
  if (state !== "ok") return { status: state === "unknown" ? 404 : 410, body: refuse(state) };
  if (!deps.auth.isEnabled() && !trustedPath) return { status: 403, body: refuse("no-password") };
  if (deps.store.redeem(code).state !== "ok") return { status: 410, body: refuse("used") };
  const net = await deps.net();
  const host: PairRedeemHost = { name: net.name, base: net.base, httpsUrl: net.httpsUrl, ...(net.lanBase ? { lanBase: net.lanBase } : {}) };
  const out: PairRedeemReply = { ok: true, host };
  if (deps.auth.isEnabled()) {
    const { token, deviceId } = deps.auth.issueToken(normalizeDeviceName(body.deviceName) ?? "paired phone", kind);
    out.token = token;
    out.deviceId = deviceId;
    if (presented && deps.auth.deviceFor(presented)) deps.auth.revoke(presented);
  } else {
    out.note = NO_PASSWORD_NOTE;
  }
  if (trustedPath) {
    const id = lanIdentity(deps.root);
    out.lanIdentity = { hostId: id.hostId, secret: id.secret };
  }
  return { status: 200, body: out };
}

/** `POST /api/pair/redeem`, before the auth gate. True when it answered. */
export async function handlePairPreAuth(req: IncomingMessage, res: ServerResponse, kind: PeerKind, deps: PairDeps): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== "/api/pair/redeem") return false;
  if (req.method !== "POST") { reply(req, res, 405, { error: "POST only" }); return true; }
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
export async function handlePairAuthed(req: IncomingMessage, res: ServerResponse, tok: string | null, deps: PairDeps): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== "/api/pair/mint") return false;
  if (req.method !== "POST") { reply(req, res, 405, { error: "POST only" }); return true; }
  const { code, expiresAt } = deps.store.mint(deps.auth.deviceFor(tok)?.id ?? null);
  const net = await deps.net();
  const out: PairMintResponse & { lanBase?: string } = {
    code, expiresAt, base: net.base,
    landingUrl: pairLandingUrl(net.base, code),
    deepLink: pairDeepLink(net.base, code),
    ...(net.lanBase ? { lanBase: net.lanBase } : {}),
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

/** The page for a live code. Pure: tests render it without a server. */
export function landingPage(code: string, net: PairNet, apk: ApkFile | null, releaseUrl: string | null = null): string {
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
  const deep = pairDeepLink(addr, code);
  return page(`Pair with ${net.name}`, `
<h1>Connect to ${esc(net.name)}</h1>
<p class="muted">This phone must be on the same tailnet, with Tailscale connected.</p>
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
  if (method !== "GET" && method !== "HEAD") { res.writeHead(405, { ...PAGE_HEADERS, allow: "GET, HEAD" }); res.end(); return; }
  const path = (req.url ?? "/").split("?")[0];
  const invalid = (status: number) => { res.writeHead(status, PAGE_HEADERS); res.end(method === "HEAD" ? undefined : invalidPage()); };
  if (!landingLimit.take(rateKey(req))) { invalid(429); return; }
  const p = pairPathCode(path);
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
  const html = landingPage(p.code, await deps.net(), apk, releaseApkUrl());
  res.writeHead(200, PAGE_HEADERS);
  res.end(method === "HEAD" ? undefined : html);
}
