// Same-origin guard: a web page on another origin must not be able to reach the
// API or open a socket, because the daemon spawns `claude` (arbitrary code).
// Covers both headers the guard checks — `Origin` (cross-origin fetch / WS) and
// `Host` (DNS rebinding) — plus the escape hatch for a custom hostname.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { configureOrigins, originHeaderAllowed, hostHeaderAllowed } from "../packages/host/dist/origin.js";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8801;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT),
  [E.HOST]: "127.0.0.1",
  ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.ALLOWED_HOSTS]: "my-box.example",
  [E.ALLOWED_ORIGINS]: "https://my-proxy.example",
  // <ENV>_DEV is deliberately NOT set: the Vite dev origin must be refused by a
  // production daemon, and trusted only when `npm run dev` starts the host.
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

/** Raw HTTP so we can set `Host` — fetch() forbids it. */
function raw(path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Resolve to "welcome" if the socket is accepted, or "closed:<code>" if not. */
function tryWs(opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, opts);
    const finish = (v) => { try { ws.close(); } catch { /* already closing */ } resolve(v); };
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === "welcome") finish("welcome");
    });
    ws.on("close", (code) => resolve(`closed:${code}`));
    ws.on("error", () => resolve("error"));
    setTimeout(() => finish("timeout"), 3000);
  });
}

bootWait(PORT, 1200, async () => {
  try {
    // ── HTTP: Origin ─────────────────────────────────────────────────
    // No Origin at all = a non-browser client (curl, these scripts, the hook
    // sink). Always allowed; a browser always sends one when it matters.
    check((await raw("/api/health")).status === 200, "no Origin → allowed (non-browser client)");

    const good = await raw("/api/health", { origin: `http://127.0.0.1:${PORT}` });
    check(good.status === 200, "own origin → allowed");
    check(
      good.headers["access-control-allow-origin"] === `http://127.0.0.1:${PORT}`,
      "CORS reflects our own origin, never `*`",
    );

    const evil = await raw("/api/health", { origin: "http://evil.example" });
    check(evil.status === 403, "foreign origin → 403");
    check(!evil.headers["access-control-allow-origin"], "foreign origin gets no CORS header");

    // A sandboxed iframe / file:// page sends the literal string `null`.
    check((await raw("/api/health", { origin: "null" })).status === 403, "Origin: null → 403");

    // State-changing endpoints are behind the same gate, not just reads.
    check(
      (await raw("/api/repo", { origin: "http://evil.example", "content-type": "application/json" }, "POST")).status === 403,
      "foreign origin cannot POST /api/repo",
    );
    // The login endpoint is gated too, so a drive-by page can't brute-force it.
    check(
      (await raw("/api/auth/status", { origin: "http://evil.example" })).status === 403,
      "foreign origin cannot reach /api/auth/*",
    );

    // ── HTTP: Host (DNS rebinding) ───────────────────────────────────
    // An attacker name that resolves to 127.0.0.1 makes requests same-origin,
    // so `Origin` alone would not catch it — the name in `Host` is not ours.
    check((await raw("/api/health", { host: "evil.example" })).status === 403, "foreign Host → 403 (DNS rebinding)");
    check((await raw("/api/health", { host: `127.0.0.1:${PORT}` })).status === 200, "our own Host → allowed");
    // On some machines os.hostname() ALREADY ends in .local (macOS with no
    // search domain) — origin.ts strips that suffix before adding `<name>.local`,
    // so the test must too, or it asks for "mac.local.local" and reads a correct
    // refusal as a failure.
    check((await raw("/api/health", { host: `${hostname().replace(/\.local$/i, "")}.local` })).status === 200, "our own mDNS name → allowed");
    check((await raw("/api/health", { host: "someone-else.local" })).status === 403, "another .local name → 403");
    check(
      (await raw("/api/health", { host: "my-box.example" })).status === 200,
      `${E.ALLOWED_HOSTS} entry → allowed`,
    );

    // ── Sec-Fetch-Site ───────────────────────────────────────────────
    // The backstop for cross-origin GETs, which carry no Origin at all: a
    // side-effecting endpoint reached by an <img src> on a malicious page.
    check(
      (await raw("/api/health", { "sec-fetch-site": "cross-site" })).status === 403,
      "cross-site fetch metadata → 403 even with no Origin",
    );
    check((await raw("/api/health", { "sec-fetch-site": "same-origin" })).status === 200, "same-origin fetch metadata → allowed");
    check((await raw("/api/health", { "sec-fetch-site": "none" })).status === 200, "user-initiated navigation → allowed");
    // ...but it must not veto an origin the operator explicitly allowlisted:
    // that is the one case where a real cross-origin call should work.
    check(
      (await raw("/api/health", { origin: "https://my-proxy.example", "sec-fetch-site": "cross-site" })).status === 200,
      `${E.ALLOWED_ORIGINS} entry survives cross-site fetch metadata`,
    );

    // The two routes a browser loads OUTSIDE fetch/XHR — `<img src>`,
    // `<a download>`, Background Fetch — carry no Origin AND, from the Android
    // shell (page on `http://localhost`, daemon on `http://100.x:8770`),
    // `Sec-Fetch-Site: cross-site`. Blanket-refusing those 403'd every gallery
    // thumbnail and every artifact download in the APK. 404 = "unknown repo",
    // i.e. the gate let it through and the router answered.
    check(
      (await raw("/api/repos/deadbeef/artifact?path=x.png", { "sec-fetch-site": "cross-site" })).status !== 403,
      "cross-site <img src> of an artifact → past the gate (the shell's thumbnails)",
    );
    check(
      (await raw("/api/repos/deadbeef/inbox/x.png", { "sec-fetch-site": "cross-site" })).status !== 403,
      "cross-site <img src> of an inbox file → past the gate",
    );
    // The exemption is for READS only: the same route with a side-effecting
    // method stays behind the backstop.
    check(
      (await raw("/api/repos/deadbeef/artifact?path=x.png", { "sec-fetch-site": "cross-site" }, "DELETE")).status === 403,
      "cross-site DELETE of an artifact → still 403",
    );
    check(
      (await raw("/api/repos/deadbeef/inbox/seen", { "sec-fetch-site": "cross-site" }, "POST")).status === 403,
      "cross-site POST inbox/seen → still 403",
    );
    // ...and only for those routes. Everything else keeps the backstop, which is
    // what the /api/health case above asserts from the other side.
    check(
      (await raw("/api/repos/deadbeef/git/status", { "sec-fetch-site": "cross-site" })).status === 403,
      "cross-site GET of a non-media API route → still 403",
    );

    // ── Origin edge cases ────────────────────────────────────────────
    check((await raw("/api/health", { origin: `http://[::1]:${PORT}` })).status === 200, "IPv6 loopback origin → allowed");
    check(
      (await raw("/api/health", { origin: "http://127.0.0.1:5173" })).status === 403,
      `Vite dev origin refused without ${E.DEV}=1`,
    );

    // Side-effecting endpoints must not be reachable by GET at all, since a
    // cross-origin GET is the one shape the Origin check cannot see.
    check(
      (await raw("/api/host/screenshot?repo=whatever")).status === 404,
      "GET /api/host/screenshot is not a route (POST only)",
    );

    // ── The `tailscale serve` front door is trusted automatically ────
    // Direct against the compiled guard: discovering the real serve config needs
    // a tailnet, and the RULE is what matters. `--https=443` claims one slot on
    // the whole machine, so a host that already serves something there is
    // fronted on another port — and the guard used to trust only the bound port,
    // 80 and 443. That made the app advertise an HTTPS address it then 403'd,
    // which is how someone stays on plain http://100.x with no service worker,
    // where a dropped tunnel replaces the app with the browser's error page.
    configureOrigins({
      port: 8770,
      tailscaleIp: "100.64.0.5",
      tailscaleDns: "box.tail1234.ts.net",
      serveUrl: "https://box.tail1234.ts.net:8771",
    });
    check(originHeaderAllowed("https://box.tail1234.ts.net:8771"), "our own serve front door on a non-standard port → allowed");
    check(hostHeaderAllowed("box.tail1234.ts.net:8771"), "that door's Host header → allowed");
    check(originHeaderAllowed("https://box.tail1234.ts.net"), "the same name on 443 stays allowed");
    check(!originHeaderAllowed("https://other-box.tail1234.ts.net:8771"), "a DIFFERENT tailnet name on that port → still refused");
    check(!originHeaderAllowed("https://evil.example:8771"), "trusting the port does not trust foreign hosts on it");
    // No serve door configured ⇒ nothing extra is trusted.
    configureOrigins({ port: 8770, tailscaleIp: "100.64.0.5", tailscaleDns: "box.tail1234.ts.net" });
    check(!originHeaderAllowed("https://box.tail1234.ts.net:8771"), "with no serve door, an odd port on our own name is refused");

    // ── WebSocket ────────────────────────────────────────────────────
    // The one that actually matters: WS is exempt from the same-origin policy,
    // so without this check any page could open a socket and spawn a session.
    check(await tryWs({}) === "welcome", "ws with no Origin → accepted");
    check(await tryWs({ origin: `http://127.0.0.1:${PORT}` }) === "welcome", "ws from our own origin → accepted");
    check(await tryWs({ origin: "http://evil.example" }) === "closed:1008", "ws from foreign origin → closed 1008");
    check(
      await tryWs({ headers: { host: "evil.example" } }) === "closed:1008",
      "ws with foreign Host → closed 1008",
    );
  } catch (e) {
    console.error(e);
    failed = true;
  }
  done();
});
