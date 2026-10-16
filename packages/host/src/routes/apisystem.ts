/**
 * HTTP routes about the daemon and the link rather than any repo: health, the
 * fork's theme, the web bundle, the two hook sinks, the four delegating
 * route modules (peers, the agent's intents, onboarding), the speed test, the
 * two telemetry roll-ups and Web Push. Moved out of `api.ts`
 * (host-architecture.md, "api.ts — the HTTP routes as tables").
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { PLUGIN_ROUTE_BODY_MAX, PROTOCOL_VERSION } from "@waterplane/shared";
import { findTarget } from "../repos.js";
import { handleOnboardRoutes } from "../onboardroutes.js";
import { claudeSignInState } from "../doctor.js";
import { themeOverlayState, wireThemeOverlay } from "../themeoverlay.js";
import { collectDebug, drainUpload, serveDownload } from "../speedtest.js";
import { sendBody, notModified, statTag } from "../httpio.js";
import { webBundleFile, webBundleManifest } from "../webbundle.js";
import { claudeBin } from "../backends/index.js";
import { handleAgentIntents } from "../agentintents.js";
import { handleAgentFollowUp } from "../agentfollowup.js";
import { handlePeerRoutes } from "../peers/routes.js";
import { PeerClient } from "../peers/client.js";
import { handlePeerAgent } from "../peers/agentpeer.js";
import { ownPtys } from "../ptycap.js";
import { ACK_WRITE_FAILED } from "../acks.js";
import { BadBody, MIME, json, readBody, readJson, serveFileStream } from "./apiio.js";
import { rangeLastByte } from "../plugins/pluginfiles.js";
import { localProcessRefusal } from "../net.js";
import { mount, route, type ApiEntry } from "./apitable.js";

/** The phone's "is that desktop signed in" asks (`/api/peers/<name>/status`), never cached. */
const peerAsker = new PeerClient();

/**
 * How late the event loop's timers fire. ONE loop pumps every PTY, so a
 * blocking call anywhere (a sync `ps`, a sync tmux query) shows up as every
 * session's output stalling at once — and nothing else on `/api/health` could
 * say so. Enabled when this module loads (host start) and read-and-reset by
 * each health call, so the figure is "the worst 1% since the last probe", not a
 * lifetime average that buries a stall that has just begun.
 */
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

/** p99 loop delay in whole ms since the previous call; 0 when nothing was sampled. */
function takeLoopDelayP99Ms(): number {
  const ms = loopDelay.count > 0 ? Math.round(loopDelay.percentile(99) / 1e6) : 0;
  loopDelay.reset();
  return ms;
}

/** A plugin id in a hook-sink path — the registry's own rule. */
const PLUGIN_HOOK_ID = /^[a-z][a-z0-9-]{1,39}$/;

export const SYSTEM_ROUTES: readonly ApiEntry[] = [
  // ── Simple GETs ─────────────────────────────────────────────────────
  route("*", "/api/health", ({ res }, ctx) => {
    // `ptys` is the leak gauge: masters this process holds vs PTYs it should
    // (one per live session, plus running builds) — see `ownPtys()`.
    // `writeErrors`: a durable store whose last write did NOT reach the disk,
    // in the error's own words — present only while one is failing. The ack
    // ledger's means a retry after a restart may run twice; the intent
    // store's means new work is being refused (`acks.ts`, `intents/disk.ts`).
    const acksErr = ctx.acks?.lastWriteError() ?? null;
    const intentsErr = ctx.intents.lastWriteError();
    const writeErrors = acksErr || intentsErr
      ? { ...(acksErr ? { acks: `${ACK_WRITE_FAILED} (${acksErr})` } : {}), ...(intentsErr ? { intents: `could not save to disk: ${intentsErr}` } : {}) }
      : undefined;
    json(res, { ok: true, protocol: PROTOCOL_VERSION, root: ctx.root, ptys: ownPtys(), sessions: ctx.sessions.list().length, loopDelayP99Ms: takeLoopDelayP99Ms(), ...(writeErrors ? { writeErrors } : {}) });
    return true;
  }),

  // A fork's `<config dir>/theme.json`, CLEANED (`themeoverlay.ts`): colour
  // tokens, the terminal palette, the display name. `{}` when there is none —
  // the phone then applies nothing. Read-only; origin-gated like every /api.
  // `icons` stays on the desktop: the served shell already links them.
  route("GET", "/api/theme", ({ res }) => {
    json(res, { overlay: wireThemeOverlay(themeOverlayState().overlay) });
    return true;
  }),

  // ── Web bundle: what the Android shell updates itself from ──────────
  // The APK carries the UI so a dead tunnel can't take the app away; these two
  // routes are what stop that from also freezing it at APK build time. See
  // webbundle.ts. Read-only, and they expose nothing `serveStatic` doesn't
  // already hand out at `/` — this is the same tree, described instead of served.
  route("*", "/api/webbundle", ({ res }) => {
    json(res, webBundleManifest());
    return true;
  }),
  route("*", "/api/webbundle/file", async ({ req, res, url }) => {
    const hit = webBundleFile(url.searchParams.get("path") || "");
    if (!hit) { json(res, { ok: false, error: "not found" }, 404); return true; }
    const etag = statTag(hit.size, hit.mtimeMs);
    // The client asks with `&v=<buildId>`, so a URL is stable exactly as long as
    // its contents are — an unchanged file costs a 304, a changed build a fetch.
    if (notModified(req, res, etag, "no-cache")) return true;
    const body = await readFile(hit.abs);
    sendBody(req, res, 200, body, {
      "content-type": MIME[extname(hit.abs)] || "application/octet-stream",
      "cache-control": "no-cache",
      etag,
    });
    return true;
  }),

  // ── claude hook lifecycle sink ──────────────────────────────────────
  // waterplane-spawned `claude` sessions POST their hook events here (injected via
  // `--settings`): the positive turn-boundary signal — Stop = turn finished,
  // SessionStart = conversation id, UserPromptSubmit = turn started. LOCAL ONLY:
  // hooks always run on this machine, so refuse anything not from loopback even
  // though a Tailscale peer could otherwise reach it (Tailscale is the app-wide
  // boundary, but this endpoint has no reason to accept remote callers) — and
  // refuse a PROXIED one too: behind `tailscale serve` every tailnet request
  // arrives from 127.0.0.1, so loopback alone proves nothing (`net.ts`,
  // `localProcessRefusal`, the one predicate all three sinks below share).
  route("POST", "/api/hook", async ({ req, res }, ctx) => {
    { const refused = localProcessRefusal(req.socket.remoteAddress, req.headers); if (refused) { json(res, { ok: false, error: refused }, 403); return true; } }
    // Keeps reading a bad body as `{}` (so do the two plugin sinks below): its caller is the
    // CLI's own hook command, which has nobody to show a 400 to, and the sink's
    // contract is "no-op on anything it cannot use" (an unknown session included).
    const body = await readJson(req, { optional: true }).catch(() => ({}));
    try { ctx.sessions.onHookEvent(body); } catch { /* a bad hook must never break the host */ }
    res.writeHead(204).end();
    return true;
  }),
  // ── a shell session's `$BROWSER` (`backends/shell.ts`'s shim) ──────
  // Same loopback rule as /api/hook: the shim runs on this machine, inside the
  // session's pane. Form-urlencoded `session` + `url`. Anything it cannot use —
  // an unknown or ended session, not a shell, not an http(s) URL, over 4 KB —
  // is 204 with nothing stored (`sessions/links.ts`): the shim exits 0 either
  // way, and a caller learns nothing about which sessions exist. Never GET.
  route("POST", "/api/shell/open", async ({ req, res }, ctx) => {
    { const refused = localProcessRefusal(req.socket.remoteAddress, req.headers); if (refused) { json(res, { ok: false, error: refused }, 403); return true; } }
    let form: URLSearchParams | null = null;
    try { form = new URLSearchParams((await readBody(req, 16 * 1024)).toString("utf8")); } catch { /* too large ⇒ nothing */ }
    if (form) { try { ctx.sessions.addBrowserLink(form.get("session") ?? "", form.get("url")); } catch { /* never break the host */ } }
    res.writeHead(204).end();
    return true;
  }),
  // ── a PLUGIN backend's hook sink (`api.hookSink()`) ─────────────────
  // The same loopback rule as /api/hook. The body goes to the plugin's
  // `onHook`; the response is its answer, HELD while that is pending and `{}`
  // once the hold runs out (`PluginRegistry.hook`).
  route("POST", "/api/plugin/:id/hook", async ({ req, res, params }, ctx) => {
    if (!PLUGIN_HOOK_ID.test(params.id!)) return false;
    { const refused = localProcessRefusal(req.socket.remoteAddress, req.headers); if (refused) { json(res, { ok: false, error: refused }, 403); return true; } }
    if (!ctx.pluginHook) { json(res, { ok: false, error: "this host runs no plugins" }, 404); return true; }
    // Tolerant like `/api/hook`: the CLI's hook command is the caller.
    const r = await ctx.pluginHook(params.id!, await readJson(req, { optional: true, anyJson: true }).catch(() => ({})));
    json(res, r.body, r.status);
    return true;
  }),
  // ── a file a plugin OFFERED (`api.offerFile()`, plugin API 1.5) ──────
  // Its own prefix, so no plugin route pattern shadows it. Bytes (ranges for a resumed download),
  // never cached; the core deletes the file once a response delivered its LAST byte
  // (`pluginfiles.ts`). Gone — fetched, expired, or never offered — is a 404 in words.
  route("GET", "/api/plugin-file/:id/:token", ({ req, res, params }, ctx) => {
    if (!PLUGIN_HOOK_ID.test(params.id!)) return false;
    const f = ctx.pluginFile?.(params.id!, params.token!) ?? null;
    if (!f) { json(res, { error: "that file is gone from the desktop — it is deleted once fetched, or when its time runs out; ask for it again" }, 404); return true; }
    const etag = `"o-${f.token.slice(0, 12)}-${f.size}"`;
    const ifRange = req.headers["if-range"];
    if (ifRange && ifRange !== etag) delete req.headers.range;
    const last = rangeLastByte(req.headers.range, f.size);
    const mime = MIME[extname(f.name).toLowerCase()] || "application/octet-stream";
    serveFileStream(req, res, f.file, f.size, mime, {
      "content-disposition": `attachment; filename="${f.name.replace(/[^\w. -]/g, "_")}"`, "cache-control": "no-store", etag,
    });
    // Delivered = the response that ends at the last byte FINISHED (every byte handed to the socket).
    if (last === f.size - 1) res.on("finish", () => f.delivered());
    return true;
  }),
  // ── a plugin's OWN routes (`api.route()`, plugin API 1.2) ────────────
  // Namespaced under its id, and served HERE — so behind the same origin/Host
  // and token gates as every route in this file; not loopback-only, never in
  // `OPAQUE_READ_ROUTES`. Nothing served ⇒ `false`, the plain 404.
  route("*", "/api/plugin/:id/*", async ({ req, res, url, method, params, rest }, ctx) => {
    if (!PLUGIN_HOOK_ID.test(params.id!) || !ctx.pluginRoute) return false;
    const run = ctx.pluginRoute(params.id!, method, rest);
    if (!run) return false;
    // A null-prototype object: `?constructor=` or `?__proto__=` is a plain key, first value wins.
    const query: Record<string, string> = Object.create(null);
    for (const [k, v] of url.searchParams) if (!Object.hasOwn(query, k)) query[k] = v;
    // Any method, so usually no body (a GET); any JSON value, since the payload is
    // the plugin's own. Over the cap ⇒ `BadBody` 413, answered by `handleApi`. Not
    // JSON ⇒ `{}`, because that is the published plugin API (`shared/plugin.ts`'s
    // `route`: "`{}` when there is none or it is not JSON") — changing it is a
    // plugin-API decision, not this edge's.
    const body: unknown = await readJson(req, { limit: PLUGIN_ROUTE_BODY_MAX, optional: true, anyJson: true })
      .catch((e: unknown) => { if (e instanceof BadBody && e.status === 400) return {}; throw e; });
    const r = await run({ query, body });
    json(res, r.body, r.status);
    return true;
  }),

  // ── Peer desktops: pairing (phone, trusted path) and the peer API (`peers/routes.ts`) ──
  mount("peers/routes", async ({ req, res, path, url }, ctx) => !!(ctx.peers && ctx.canManage && await handlePeerRoutes(req, res, path, url, {
    store: ctx.peers, canManage: ctx.canManage, json, readJson: (r) => readJson(r),
    signedIn: () => claudeSignInState(claudeBin()),
    askPeer: (t) => peerAsker.helloFresh(t),
  }))),
  // `/api/agent/peer/<peer>/intents`: the agentintents twin that hands a job to a peer (`peers/agentpeer.ts`).
  mount("peers/agentpeer", ({ req, res, path, url }) => handlePeerAgent(req, res, path, url, { json, readJson: (r) => readJson(r) })),

  // ── Later work posted by an AGENT on this desktop ───────────────────
  // `POST|GET|DELETE /api/agent/intents[/<id>]` — loopback-only, never a
  // browser, never proxied (`agentCallerRefusal`), and one path into the store
  // with the phone's `intent.post` (`postClientDraft`). See agentintents.ts.
  mount("agentintents", ({ req, res, path, url }, ctx) => handleAgentIntents(req, res, path, url, {
    intents: ctx.intents,
    backlog: ctx.backlog,
    periods: ctx.periods,
    containRepoDir: (d) => ctx.containRepoDir(d),
    sessionCwd: (id) => { const s = ctx.sessions.get(id); return s && s.running ? s.cwd : null; },
    repoDir: async (id) => (await findTarget(ctx.root, id))?.worktreePath ?? null,
    json,
    readJson: (r) => readJson(r),
  })),

  // `POST /api/agent/followup` — an agent flags its OWN session for follow up; sets, never clears (`agentfollowup.ts`).
  mount("agentfollowup", ({ req, res, path }, ctx) => handleAgentFollowUp(req, res, path, { sessions: ctx.sessions, json, readJson: (r) => readJson(r) })),

  // ── First app: plan, start, resume, read back (`onboardroutes.ts`) ──
  mount("onboardroutes", ({ req, res, path, url }, ctx) => handleOnboardRoutes(req, res, path, url, { onboard: ctx.onboard, json, readJson: (r) => readJson(r, { optional: true }), signedIn: () => claudeSignInState(claudeBin()) })),

  // ── Speed test (bidirectional throughput + connection diagnostics) ──
  // Not repo-scoped: it measures the transport, not any repo. Traffic rides
  // whatever origin the phone loaded (Tailscale IP or LAN IP), so the numbers
  // reflect the real path in use.
  route("GET", "/api/speedtest/download", ({ res, url }) => {
    serveDownload(res, Number(url.searchParams.get("bytes") || 0));
    return true;
  }),
  route("POST", "/api/speedtest/upload", async ({ req, res }) => {
    try {
      json(res, { ok: true, ...(await drainUpload(req)) });
    } catch (e) {
      json(res, { ok: false, error: String((e as Error).message || e) }, 413);
    }
    return true;
  }),
  route("GET", "/api/speedtest/debug", async ({ req, res }) => {
    json(res, await collectDebug(req));
    return true;
  }),

  // ── UI feature-usage counters ───────────────────────────────────────
  // POST a delta ({ counts: { "toolbar:diff": 3 } }) — the phone batches its
  // local tracking and flushes here (fetch keepalive / sendBeacon on hide), so
  // this must stay cheap and never fail the client. GET returns the whole doc
  // (Settings → feature usage); DELETE resets the window.
  route("POST", "/api/ui-usage", async ({ req, res }, ctx) => {
    const body = await readJson(req, { optional: true });
    const n = ctx.uiStats.merge(body?.counts ?? body);
    json(res, { ok: true, merged: n });
    return true;
  }),
  route("GET", "/api/ui-usage", ({ res }, ctx) => {
    json(res, ctx.uiStats.get());
    return true;
  }),
  route("DELETE", "/api/ui-usage", ({ res }, ctx) => {
    ctx.uiStats.reset();
    json(res, { ok: true });
    return true;
  }),

  // Connectivity + delivery telemetry (netstats.ts). The phone POSTs a small
  // roll-up of its OWN side of the link — socket RTT, reconnects, how long text
  // sat queued — which the host cannot observe; the host contributes the socket
  // lifecycle and the outcome of every verified compose delivery. Same shape of
  // contract as /api/ui-usage: cheap, never fails the client, DELETE resets the
  // window. Nothing here leaves the machine.
  route("POST", "/api/netstats", async ({ req, res }, ctx) => {
    const body = await readJson(req, { optional: true });
    ctx.netstats.putClientReport(String(body?.deviceId ?? ""), body?.report ?? body);
    json(res, { ok: true });
    return true;
  }),
  route("GET", "/api/netstats", ({ res }, ctx) => {
    json(res, ctx.netstats.snapshot());
    return true;
  }),
  route("DELETE", "/api/netstats", ({ res }, ctx) => {
    json(res, ctx.netstats.reset());
    return true;
  }),

  // ── Web Push ────────────────────────────────────────────────────────
  route("GET", "/api/push/key", ({ res }, ctx) => {
    json(res, { key: ctx.push.publicKey });
    return true;
  }),
  route("POST", "/api/push/subscribe", async ({ req, res }, ctx) => {
    const sub = await readJson(req);
    ctx.push.subscribe(sub);
    json(res, { ok: true });
    return true;
  }),
  route("POST", "/api/push/unsubscribe", async ({ req, res }, ctx) => {
    const { endpoint } = await readJson(req, { optional: true });
    if (endpoint) ctx.push.unsubscribe(String(endpoint));
    json(res, { ok: true });
    return true;
  }),
];
