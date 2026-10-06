/**
 * The HTTP surface: the LAN password gate's endpoints, the static web app, the
 * per-request handler every bind's `createServer` is given, and the bind retry.
 *
 * Moved verbatim out of `main.ts` (M6 of the host split, see
 * docs/notes/host-architecture.md). Every main-scope name is read as
 * `ctx.<name>` at CALL time — `listenWithRetry`'s callback reaches `intents`
 * and `smartpick`, and the handler reaches every manager, all of which exist by
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
import { normalizeDeviceName, type DeviceTokenResponse, type PeerKind, logTag, envName, BRAND } from "@waterplane/shared";
import { peerKind } from "../net.js";
import { canonicalRequestPath, checkRequestOrigin, corsHeaders } from "../origin.js";
import { cookieToken, tokenFromRequest, authCookie, clearAuthCookie } from "../auth.js";
import { handleAuthedRoutes, handleLanPreAuth, type AuthRouteDeps } from "../authroutes.js";
import { discoverTailnetPeers } from "../tailnetpeers.js";
import { PairStore, handlePairAuthed, handlePairPage, handlePairPreAuth, latestApk, pairNet, type PairDeps } from "../pair.js";
import { USAGE_POLL_MS } from "../usage.js";
import { handleApi, answerPreflight } from "../api.js";
import { sendBody, statTag, notModified } from "../httpio.js";
import { WEB_DIST } from "../webbundle.js";
import { brandIndexHtml, brandManifest, iconUrlsTag, themeIconFile, themeIconUrls, themeOverlayState, THEME_ICON_PREFIX } from "../themeoverlay.js";
import type { ServerCtx } from "./ctx.js";

// ── HTTP: API router, then static web app ────────────────────────────

// `as`, not an annotation: hostshape allows a column-0 `const NAME = ` only.
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
} as Record<string, string>;

export function createHttp(ctx: ServerCtx) {
  // Pairing codes: memory only, so a restart invalidates every outstanding one.
  const pairs = new PairStore();
  const pairDeps = (): PairDeps => ({ root: ctx.ROOT, port: ctx.PORT, auth: ctx.auth, store: pairs, net: () => pairNet(ctx.PORT), apk: () => latestApk() });
  async function readSmallJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > 1_000_000) { req.destroy(); return {}; }
      chunks.push(c as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
  }

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
      const authed = !ctx.auth.needsToken(kind) || ctx.auth.checkToken(tokenFromRequest(req.headers), kind);
      res.writeHead(200, jsonHead);
      res.end(JSON.stringify({ kind, authed, ...ctx.authStateFor(kind) }));
      return;
    }
    if (url.pathname === "/api/auth/login" && method === "POST") {
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
      const trusted = !ctx.auth.needsToken(kind) || ctx.auth.checkToken(tokenFromRequest(req.headers), kind);
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
    let filePath = join(WEB_DIST, safe);
    if (!filePath.startsWith(WEB_DIST) || !existsSync(filePath)) filePath = join(WEB_DIST, "index.html");
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
    const kind = peerKind(req.socket.remoteAddress);
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
      const originOk = checkRequestOrigin(req.headers, { path: p, method: req.method });
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
      if (p.startsWith("/api/pair/") && await handlePairAuthed(req, res, tok, pairDeps())) return;
      // `launches` is the intent store: `api.ts` needs exactly one method of it —
      // "an upload landed in this worktree, re-ask the gate now".
      const handled = await handleApi(req, res, {
        root: ctx.ROOT, push: ctx.push, sessions: ctx.sessions, uiStats: ctx.uiStats, netstats: ctx.netstats, setup: ctx.setupWatch, launches: ctx.intents,
        tokenStats: ctx.tokenStats, usageLog: ctx.usageLog, usagePollMs: USAGE_POLL_MS, capture: ctx.capture,
        intents: ctx.intents, backlog: ctx.backlog, containRepoDir: (d) => ctx.containRepoDir(d), onboard: ctx.onboard,
        pluginHook: (id, payload) => ctx.plugins.hook(id, payload),
        pluginRoute: (id, method, parts) => ctx.plugins.route(id, method, parts),
        peers: ctx.peers, canManage: (k) => ctx.auth.canManage(k),
        // A hand-asked image read spends the same key a plugin may, so it is
        // metered the same way and kept apart by `kind` — "a plugin got
        // expensive" and "I highlighted forty screenshots" are different facts.
        noteOcrUsage: ({ model, inTok, outTok }) =>
          ctx.meter.record({ service: "gemini", model, kind: "ocr", inTok, outTok, ts: Date.now() }),
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
      // …and only THEN ask what the intents that were mid-flight when the last
      // process died actually mean. A tmux session outlives the daemon, so "is
      // that session still there" is not answerable until the map is rebuilt.
      // Idempotent: several binds call this, and it reconciles once.
      void ctx.intents.reconcile().then(() => {
        // …and only then finish any merge the last process died in the middle of.
        // After reconciliation for the same reason reconciliation runs after
        // `rediscover()`: the store has to be settled before anything writes to
        // it. Every step of an apply is idempotent, so completing an interrupted
        // one twice is completing it once — and leaving one half-applied is the
        // only way this feature could lose somebody's work.
        try { ctx.smartpick.finishApplying(); } catch (e) { console.error(`${logTag} smartpick resume failed`, e); }
      });
    });
  }

  return { handler, listenWithRetry };
}
