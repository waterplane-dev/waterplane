/**
 * The HTTP surface: the LAN password gate's endpoints, the static web app, the
 * per-request handler every bind's `createServer` is given, and the bind retry.
 *
 * Moved verbatim out of `main.ts` (M6 of the host split, see
 * docs/notes/host-architecture.md). Every main-scope name is read as
 * `ctx.<name>` at CALL time — `listenWithRetry`'s callback reaches `intents`,
 * and the handler reaches every manager, all of which exist by
 * the time `main()` binds.
 *
 * Security-critical and unchanged: the origin/Host gate runs ahead of
 * everything else on `/api/`, auth endpoints stay reachable, a gated peer
 * without a token gets 401, and no response here carries a wildcard CORS
 * header (`corsHeaders` reflects only an allowed origin). The public-bind
 * refusal is `main()`'s and stays there.
 */
import type { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { normalizeDeviceName, type DeviceTokenResponse, type PassiveAuthFields, type PassiveStateResponse, type PeerKind, logTag, envName, BRAND } from "@waterplane/shared";
import { passiveAllows, passiveItems, passiveNeverAllows, queuedApkIn } from "../passive.js";
import { requestPeerKind, isProxied } from "../net.js";
import { RateLimiter, rateKey } from "../ratelimit.js";
import { canonicalRequestPath, checkRequestOrigin, corsHeaders } from "../origin.js";
import { cookieToken, tokenFromRequest, authCookie, clearAuthCookie } from "../auth.js";
import { handleAuthedRoutes, handleLanPreAuth, type AuthRouteDeps } from "../authroutes.js";
import { discoverTailnetPeers } from "../tailnetpeers.js";
import { PairStore, handlePairAuthed, handlePairPage, handlePairPreAuth, latestApk, pairNet, type PairDeps } from "../pair.js";
import { USAGE_POLL_MS } from "../usage.js";
import { handleApi, answerPreflight } from "../api.js";
import { sendBody, statTag, notModified, readJsonBody, answerBadBody } from "../httpio.js";
import { contained } from "../paths.js";
import { WEB_DIST } from "../webbundle.js";
import { brandIndexHtml, brandManifest, iconUrlsTag, themeIconFile, themeIconUrls, themeOverlayState, THEME_ICON_PREFIX } from "../themeoverlay.js";
import type { ServerCtx } from "./ctx.js";
import { appReadinessReport } from "../appready.js";
import { backendInfos } from "../backends/index.js";

// ── HTTP: API router, then static web app ────────────────────────────

// `as`, not an annotation: hostshape allows a column-0 `const NAME = ` only.
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
} as Record<string, string>;

export function createHttp(ctx: ServerCtx) {
  /** Password logins per source address: a burst of 10, then one every two seconds. */
  const loginLimit = new RateLimiter({ burst: 10, perSec: 0.5 });
  /** All source addresses together: behind a proxy every caller can look like one, and many can look like many. */
  const globalLoginLimit = new RateLimiter({ burst: 60, perSec: 2 });
  // Pairing codes: memory only, so a restart invalidates every outstanding one.
  const pairs = new PairStore();
  const pairDeps = (): PairDeps => ({
    root: ctx.ROOT, port: ctx.PORT, auth: ctx.auth, store: pairs, net: () => pairNet(ctx.PORT), apk: () => latestApk(),
    // A passive redeem switches the Tailscale gate on: the tokenless Tailscale sockets that
    // are open right now are told (`authRequired`) and closed, as `auth.gateTailscale` would.
    onGateChange: () => { ctx.enforceAuth(); ctx.broadcastAuthState(); },
  });
  // Empty ⇒ `{}` (the field checks below refuse in their own words); malformed
  // or over 1 MB ⇒ `BadBody`, answered 400/413 by `fail` — never "wrong password"
  // for a body that never arrived whole.
  const readSmallJson = (req: IncomingMessage): Promise<any> => readJsonBody(req, { optional: true });

  /**
   * LAN password gate HTTP surface (always reachable, even from an un-authed LAN
   * socket, so a device can log in): status / login / logout. Login only succeeds
   * once a password has been set from the trusted path; a correct password mints a
   * token delivered as an httpOnly cookie the browser replays on fetch + WS upgrade.
   */
  async function handleAuthHttp(req: IncomingMessage, res: ServerResponse, kind: PeerKind): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const jsonHead = { "content-type": "application/json", ...corsHeaders(req.headers) } as Record<string, string>;

    if (url.pathname === "/api/auth/status" && method === "GET") {
      const tok = tokenFromRequest(req.headers);
      const authed = !ctx.auth.needsToken(kind) || ctx.auth.checkToken(tok, kind);
      res.writeHead(200, jsonHead);
      res.end(JSON.stringify({ kind, authed, ...ctx.authStateFor(kind), ...passiveFields(tok) }));
      return;
    }
    // Passive devices (`passive.ts`): the unlock is the passive token's own
    // route — the one write it may make — and rate-limited per device there.
    if (url.pathname === "/api/auth/unlock" && method === "POST") {
      const row = ctx.auth.deviceFor(tokenFromRequest(req.headers), kind);
      const body = await readSmallJson(req);
      const r = ctx.auth.passive.unlock(row, body.pin);
      const status = r.ok ? 200 : r.error === "rate-limited" ? 429 : r.error === "bad-request" ? 400 : r.error === "no-pin" ? 409 : 403;
      const { retryAfterMs, ...out } = r;
      res.writeHead(status, { ...jsonHead, "cache-control": "no-store", ...(retryAfterMs ? { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } : {}) });
      res.end(JSON.stringify(out));
      return;
    }
    if (url.pathname === "/api/auth/lock" && method === "POST") {
      const row = ctx.auth.deviceFor(tokenFromRequest(req.headers), kind);
      const locked = row ? ctx.auth.passive.lock(row.id) : false;
      res.writeHead(200, jsonHead);
      res.end(JSON.stringify({ ok: true, locked }));
      return;
    }
    // The unlock PIN: set or cleared only from the trusted path (loopback /
    // Tailscale, holding a valid token when that path is gated) and never by a
    // passive token — not even one that is unlocked right now.
    if (url.pathname === "/api/auth/pin" && method === "POST") {
      const tok = tokenFromRequest(req.headers);
      const row = ctx.auth.deviceFor(tok, kind);
      const trusted = ctx.auth.canManage(kind) && (!ctx.auth.needsToken(kind) || !!row) && row?.scope !== "passive";
      if (!trusted) { res.writeHead(403, jsonHead); res.end(JSON.stringify({ ok: false, error: "The unlock PIN is set from a trusted phone over Tailscale, or on the desktop — never from a passive device or the Wi-Fi route." })); return; }
      const body = await readSmallJson(req);
      try { ctx.auth.passive.setPin(body.pin === null ? null : String(body.pin ?? "")); } catch (e) {
        res.writeHead(400, jsonHead); res.end(JSON.stringify({ ok: false, error: (e as Error).message })); return;
      }
      res.writeHead(200, jsonHead);
      res.end(JSON.stringify({ ok: true, pinSet: ctx.auth.passive.pinSet() }));
      return;
    }
    if (url.pathname === "/api/auth/login" && method === "POST") {
      // Before the scrypt verify: a guess costs the host CPU and the attacker only a request.
      const lk = rateKey(req);
      if (!globalLoginLimit.take("*") || !loginLimit.take(lk)) {
        res.writeHead(429, { ...jsonHead, "retry-after": String(Math.ceil(Math.max(loginLimit.retryAfterMs(lk), globalLoginLimit.retryAfterMs("*")) / 1000) || 1) });
        res.end(JSON.stringify({ ok: false, error: "too many attempts — wait a moment and try again" }));
        return;
      }
      const body = await readSmallJson(req);
      if (!ctx.auth.isEnabled()) { res.writeHead(403, jsonHead); res.end(JSON.stringify({ ok: false, error: "no password set on host" })); return; }
      if (!ctx.auth.verify(String(body.password ?? ""))) { res.writeHead(401, jsonHead); res.end(JSON.stringify({ ok: false, error: "wrong password" })); return; }
      // A browser logging in again replaces its own row rather than adding one.
      ctx.auth.revoke(cookieToken(req.headers.cookie));
      const { token } = ctx.auth.issueToken(normalizeDeviceName(body.deviceName) ?? browserName(req.headers["user-agent"]), kind);
      res.writeHead(200, { ...jsonHead, "set-cookie": authCookie(token) });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // A per-device token for a caller that is ALREADY trusted (loopback, an
    // ungated Tailscale peer, or one holding a valid token) — the Android
    // shell, whose cookie is withheld cross-site, carries it as a Bearer
    // header and a WS subprotocol instead. No password retyping over the
    // tailnet; still nothing while no password is set (deny-until-set).
    if (url.pathname === "/api/auth/token" && method === "POST") {
      // Minting is a desktop / Tailscale act: a token already in hand over the
      // Wi-Fi route (or Funnel) must not breed more of them.
      if (!ctx.auth.canManage(kind)) { res.writeHead(403, jsonHead); res.end(JSON.stringify({ ok: false, error: "a device token is minted on the desktop or over Tailscale, never from the Wi-Fi route" })); return; }
      const presented = ctx.auth.deviceFor(tokenFromRequest(req.headers), kind);
      // A passive token never mints another — unlocked or not, a full token
      // would outlive the 30 minutes.
      if (presented?.scope === "passive") { res.writeHead(403, jsonHead); res.end(JSON.stringify({ ok: false, error: "passive device", passive: true })); return; }
      const trusted = !ctx.auth.needsToken(kind) || !!presented;
      if (!trusted) { res.writeHead(401, jsonHead); res.end(JSON.stringify({ ok: false, error: "auth required", authRequired: true, enabled: ctx.auth.isEnabled() })); return; }
      if (!ctx.auth.isEnabled()) { res.writeHead(403, jsonHead); res.end(JSON.stringify({ ok: false, error: "no password set on host" })); return; }
      const body = await readSmallJson(req);
      const name = normalizeDeviceName(body.deviceName);
      if (!name) { res.writeHead(400, jsonHead); res.end(JSON.stringify({ ok: false, error: "deviceName required" })); return; }
      const { token, deviceId } = ctx.auth.issueToken(name, kind);
      const out: DeviceTokenResponse = { token, deviceId };
      res.writeHead(200, { ...jsonHead, "cache-control": "no-store" });
      res.end(JSON.stringify(out));
      return;
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") {
      ctx.auth.revoke(tokenFromRequest(req.headers));
      res.writeHead(200, { ...jsonHead, "set-cookie": clearAuthCookie() });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, jsonHead);
    res.end(JSON.stringify({ error: "not found" }));
  }

  /** What `/api/auth/status` adds about a passive caller and the PIN. */
  function passiveFields(tok: string | null): PassiveAuthFields {
    const row = ctx.auth.deviceFor(tok);
    const pin = { pinSet: ctx.auth.passive.pinSet() };
    if (row?.scope !== "passive") return pin;
    const until = ctx.auth.passive.unlockedUntil(row.id);
    return { ...pin, scope: "passive", ...(until ? { unlockedUntil: until } : {}) };
  }

  /** A name for a browser row in the device list when it sent none: its
   *  platform off the User-Agent, never the whole string. */
  function browserName(ua: string | undefined): string {
    const u = ua ?? "";
    const os = /Android/i.test(u) ? "Android" : /iPhone|iPad/i.test(u) ? "iOS" : /Mac OS X/i.test(u) ? "Mac"
      : /Windows/i.test(u) ? "Windows" : /Linux/i.test(u) ? "Linux" : "";
    return os ? `browser on ${os}` : "browser";
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    // A fork's icon (`theme.json` → `icons`): the URL names a SLOT, never a
    // path; `themeIconFile` resolves, contains and sniffs it. Ungated like the
    // rest of the shell it belongs to (`/assets/icon-*.png` are), read-only.
    if (url.pathname.startsWith(THEME_ICON_PREFIX)) {
      const r = (req.method === "GET" || req.method === "HEAD") ? themeIconFile(url.pathname.slice(THEME_ICON_PREFIX.length)) : { error: "method" };
      if ("error" in r) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
      const etag = `W/"ti-${r.tag}"`;
      const cc = "no-cache";
      if (notModified(req, res, etag, cc)) return;
      res.writeHead(200, {
        "content-type": r.mime, "cache-control": cc, etag, "content-length": String(r.body.length),
        "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end(req.method === "HEAD" ? undefined : r.body);
      return;
    }
    if (!existsSync(WEB_DIST)) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end(`Web build not found. Run \`npm run build -w @${BRAND.name}/web\` (or use the dev server).`);
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    // `contained`, not a bare `startsWith(WEB_DIST)`: that also admitted a
    // sibling such as `web/dist-old/` (no separator in the comparison).
    let filePath = contained(WEB_DIST, safe) ?? "";
    if (!filePath || !existsSync(filePath)) filePath = join(WEB_DIST, "index.html");
    try {
      // Vite emits content-hashed names under /assets — those can be cached
      // forever. index.html (and anything else) must revalidate, but gets an ETag
      // so an unchanged shell costs a 304 rather than the bundle again.
      const hashed = filePath.startsWith(join(WEB_DIST, "assets")) && /-[A-Za-z0-9_]{8,}\./.test(filePath);
      const cc = hashed ? "public, max-age=31536000, immutable" : "no-cache";
      let etag = "";
      try { const st = statSync(filePath); etag = statTag(st.size, st.mtimeMs); } catch { /* no validator */ }
      // A fork's display name and icons in the install manifest, and its icons
      // in the shell's <link>s (`themeoverlay.ts`); no overlay ⇒ the file as
      // built, validator and all.
      const isManifest = extname(filePath) === ".webmanifest";
      const isIndex = filePath === join(WEB_DIST, "index.html");
      const brandName = isManifest ? themeOverlayState().overlay.displayName : undefined;
      const icons = isManifest || isIndex ? themeIconUrls() : {};
      if (brandName && etag) etag = etag.replace(/"$/, `-${Buffer.from(brandName).toString("hex")}"`);
      const iconTag = iconUrlsTag(icons);
      if (iconTag && etag) etag = etag.replace(/"$/, `-i${iconTag}"`);
      if (etag && notModified(req, res, etag, cc)) return;
      const raw = await readFile(filePath);
      const body = isManifest ? brandManifest(raw, brandName, icons) : isIndex ? brandIndexHtml(raw, icons) : raw;
      // sendBody br/gzip-negotiates: the JS bundle is the biggest single download
      // a cold phone makes, and it compresses ~4x.
      sendBody(req, res, 200, body, {
        "content-type": MIME[extname(filePath)] || "application/octet-stream",
        "cache-control": cc,
        ...(etag ? { etag } : {}),
      }, etag ? `${filePath}\0${etag}` : undefined);
    } catch {
      res.writeHead(404).end("Not found");
    }
  }

  /** The `createServer` callback, one per bind in `main()` (it keeps no
   *  per-server state, so one function serves every bind). */
  function handler(req: IncomingMessage, res: ServerResponse): void {
    const kind = requestPeerKind(req.socket.remoteAddress, req.headers);
    const canon = canonicalRequestPath(req.url);
    if (canon === null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "non-canonical request path" }));
      return;
    }
    const p = canon;
    // Cross-origin / DNS-rebinding gate, ahead of everything else on /api —
    // including the auth endpoints, so a drive-by page can't brute-force the
    // password either. Static assets stay ungated (the SPA shell is public).
    if (p.startsWith("/api/")) {
      const originOk = checkRequestOrigin(req.headers, { path: p, method: req.method, proxied: isProxied(req.headers) });
      if (!originOk.ok) {
        console.warn(`${logTag} refused ${p}: ${originOk.reason}. If this is your own hostname, set ${envName("ALLOWED_HOSTS")}.`);
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "origin not allowed" }));
        return;
      }
    }
    // A CORS preflight carries no credentials by design (never a cookie, never
    // the Authorization header it is asking permission for), so it is answered
    // here, past the origin gate and before the token gate — otherwise every
    // Bearer request from the Android shell over LAN dies at a 401 preflight.
    // It answers headers only; no route runs.
    if (p.startsWith("/api/") && req.method === "OPTIONS") { answerPreflight(req, res); return; }
    const fail = (err: unknown) => {
      // A bad JSON body on the auth/pair/LAN paths, which `handleApi` never sees.
      if (answerBadBody(res, err, corsHeaders(req.headers))) return;
      console.error(`${logTag} http error`, err);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    };
    // Auth endpoints (login/logout/status/token) are always reachable — a gated
    // LAN client must be able to log in. Static assets (the SPA shell) are also
    // ungated so the login page can load; they carry no secrets.
    if (p.startsWith("/api/auth/")) { handleAuthHttp(req, res, kind).catch(fail); return; }
    // The pairing landing page + APK (`pair.ts`): outside `/api/`, so no origin
    // check and no token gate — a brand-new phone has neither. It answers
    // nothing about this desktop until the code in the path checks out.
    if (p === "/pair" || p.startsWith("/pair/")) { handlePairPage(req, res, pairDeps()).catch(fail); return; }
    const deps: AuthRouteDeps = { root: ctx.ROOT, auth: ctx.auth, closeDevice: (id) => ctx.closeDevice(id) };
    // `/api/lan/*` pre-auth: verify answers anyone (rate-limited); identity is
    // refused for every peer kind but loopback/Tailscale BEFORE the token gate,
    // so a LAN token never unlocks it. Pairing redeem is pre-auth beside it:
    // the code is the credential (single use, rate-limited per IP).
    const preAuth = p.startsWith("/api/lan/") ? handleLanPreAuth(req, res, kind, deps)
      : p === "/api/pair/redeem" ? handlePairPreAuth(req, res, kind, pairDeps())
      : Promise.resolve(false);
    void preAuth.then((done) => (done ? undefined : gated())).catch(fail);

    /** The token gate, then the ledger + identity routes, then the API. */
    async function gated(): Promise<void> {
      const tok = tokenFromRequest(req.headers);
      // `/api/peer/*` is the one prefix a DEVICE token neither unlocks nor is asked for: the
      // other daemon presents a PEER token, which `peers/routes.ts` checks (and refuses a
      // device token, a LAN caller and a missing token there).
      const peerApi = p === "/api/peer" || p.startsWith("/api/peer/");
      if (p.startsWith("/api/") && !peerApi && ctx.auth.needsToken(kind) && !ctx.auth.checkToken(tok, kind)) {
        res.writeHead(401, { "content-type": "application/json", ...corsHeaders(req.headers) });
        res.end(JSON.stringify({ error: "auth required", authRequired: true, enabled: ctx.auth.isEnabled() }));
        return;
      }
      // A passive token (`passive.ts`): default deny over every `/api/` route,
      // `/api/peer/*` included; only `passiveAllows`' list passes.
      if (p.startsWith("/api/") && ctx.auth.restricted(tok)) {
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        if (!passiveAllows(req.method ?? "GET", p, query, queuedApkIn(ctx.autopull.list()))) {
          res.writeHead(403, { "content-type": "application/json", ...corsHeaders(req.headers) });
          res.end(JSON.stringify({ error: "passive device", passive: true }));
          return;
        }
      }
      // An UNLOCKED passive row is full scope for 30 minutes — except for auth
      // material, which would outlive the unlock (`passiveNeverAllows`).
      if (p.startsWith("/api/") && passiveNeverAllows(req.method ?? "GET", p) && ctx.auth.deviceFor(tok)?.scope === "passive") {
        res.writeHead(403, { "content-type": "application/json", ...corsHeaders(req.headers) });
        res.end(JSON.stringify({ error: "passive device", passive: true }));
        return;
      }
      if (p === "/api/passive/state" && req.method === "GET") {
        const row = ctx.auth.deviceFor(tok);
        const out: PassiveStateResponse = {
          items: passiveItems(ctx.autopull.list()), checkedAt: Date.now(),
          unlockedUntil: row?.scope === "passive" ? ctx.auth.passive.unlockedUntil(row.id) : null,
          pinSet: ctx.auth.passive.pinSet(),
        };
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(req.headers) });
        res.end(JSON.stringify(out));
        return;
      }
      if ((p.startsWith("/api/lan/") || p.startsWith("/api/devices")) && await handleAuthedRoutes(req, res, kind, tok, deps)) return;
      // Tailnet discovery: read-only, and ONLY for a trusted path (loopback / Tailscale) — a LAN
      // or public caller never gets a map of the tailnet, token or not.
      if (p === "/api/tailnet/peers") {
        const hdr = { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(req.headers) };
        if (kind !== "loopback" && kind !== "tailscale") { res.writeHead(403, hdr); res.end(JSON.stringify({ error: "tailnet discovery is for loopback and Tailscale only" })); return; }
        if (req.method !== "GET") { res.writeHead(405, hdr); res.end(JSON.stringify({ error: "GET only" })); return; }
        const found = await discoverTailnetPeers([ctx.PORT]);
        res.writeHead(200, hdr);
        res.end(JSON.stringify(found));
        return;
      }
      if (p.startsWith("/api/pair/") && await handlePairAuthed(req, res, tok, pairDeps(), kind)) return;
      // `launches` is the intent store: `api.ts` needs exactly one method of it —
      // "an upload landed in this worktree, re-ask the gate now".
      const handled = await handleApi(req, res, {
        root: ctx.ROOT, push: ctx.push, sessions: ctx.sessions, uiStats: ctx.uiStats, netstats: ctx.netstats, setup: ctx.setupWatch, health: ctx.healthWatch, attention: ctx.attention, resolveAttention: ctx.resolveAttention, builds: ctx.builds, launches: ctx.intents,
        periods: () => ctx.budget.get().periods ?? [], tokenStats: ctx.tokenStats, usageLog: ctx.usageLog, usageSources: ctx.usageSources, usagePollMs: USAGE_POLL_MS, bootId: ctx.BOOT_ID, capture: ctx.capture, weekBurn: ctx.weekBurn,
        usageNow: () => ({
          usage: ctx.usage.get(), readings: ctx.usageSources.readings(), billing: ctx.billing.status(),
          budget: ctx.budget.get(), periods: ctx.budget.periods(), backends: backendInfos(),
        }),
        intents: ctx.intents, acks: ctx.acks, backlog: ctx.backlog, containRepoDir: (d) => ctx.containRepoDir(d), onboard: ctx.onboard,
        appReadiness: () => appReadinessReport(ctx.ROOT, (d) => ctx.builds.list(d), (d) => ctx.autopull.config(d)),
        pluginHook: (id, payload) => ctx.plugins.hook(id, payload),
        pluginRoute: (id, method, parts) => ctx.plugins.route(id, method, parts),
        pluginAsset: (id, file) => ctx.plugins.assetFile(id, file),
        pluginFile: (id, token) => ctx.plugins.offeredFile(id, token),
        peers: ctx.peers, canManage: (k) => ctx.auth.canManage(k),
      });
      if (!handled) await serveStatic(req, res);
    }
  }

  /**
   * Bind with retry. A restart often races the previous process's shutdown, so a
   * transient EADDRINUSE is expected — retry for a few seconds while the old
   * process releases the port. If it never frees, EXIT (don't linger as a
   * half-bound zombie) so a supervisor / restart script gets a clean failure.
   */
  function listenWithRetry(server: ReturnType<typeof createServer>, host: string, port: number, attemptsLeft = 20): void {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && attemptsLeft > 0) {
        if (attemptsLeft % 5 === 0) console.warn(`${logTag} ${host}:${port} busy, retrying… (${attemptsLeft} left)`);
        setTimeout(() => listenWithRetry(server, host, port, attemptsLeft - 1), 500);
        return;
      }
      console.error(`${logTag} cannot bind ${host}:${port}:`, e.code || e);
      process.exit(1);
    });
    server.listen(port, host, () => {
      console.log(`${logTag} listening http://${host}:${port}  (root: ${ctx.ROOT})`);
      // Re-attach any claude sessions that survived a restart in tmux.
      // Done after listen so the map is ready before clients connect.
      try { ctx.sessions.rediscover(); } catch (e) { console.error(`${logTag} rediscover failed`, e); }
      markReady();
      // …and only THEN ask what the intents that were mid-flight when the last
      // process died actually mean. A tmux session outlives the daemon, so "is
      // that session still there" is not answerable until the map is rebuilt.
      // Idempotent: several binds call this, and it reconciles once.
      void ctx.intents.reconcile();
    });
  }

  return { handler, listenWithRetry };
}

/**
 * When this process started, and when it could first answer: `readyAt` is
 * stamped after `rediscover()` re-attached every surviving session, which is
 * synchronous and blocks the event loop (~25 s with a hundred panes) — so no
 * `welcome` can be sent before it, and the gap between the two is how long a
 * restart kept the phone waiting. Both ride `welcome` (`host.restarting`).
 */
export const bootClock: { startedAt: number; readyAt?: number } = {
  startedAt: Math.round(Date.now() - process.uptime() * 1000),
};

export function markReady(): void {
  bootClock.readyAt ??= Date.now();
}
