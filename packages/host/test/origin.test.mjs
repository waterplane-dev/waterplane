/**
 * The browser half of the security boundary.
 *
 * Tailscale network identity decides WHO may talk to the daemon; it says
 * nothing about which web page is doing the talking, and a WebSocket ignores
 * the same-origin policy entirely. This is the gate that closes that, and its
 * failure mode is a page on the open internet driving a daemon that spawns
 * `claude` — so each rule below is pinned separately rather than as one
 * "allowed / not allowed".
 *
 * `e2e-origin.mjs` drives the same rules through a live server. These are the
 * table itself, which is where a widening would actually be introduced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRequestOrigin, configureOrigins, corsHeaders, hostHeaderAllowed, originHeaderAllowed } from "../dist/origin.js";

configureOrigins({
  port: 8770,
  tailscaleIp: "100.64.0.1",
  tailscaleDns: "mac.example-tailnet.ts.net",
});

test("our own origins pass", () => {
  assert.equal(originHeaderAllowed("http://100.64.0.1:8770"), true);
  assert.equal(originHeaderAllowed("http://127.0.0.1:8770"), true);
  assert.equal(originHeaderAllowed("https://mac.example-tailnet.ts.net"), true);
});

test("a stranger's origin does not", () => {
  assert.equal(originHeaderAllowed("https://evil.example.com"), false);
  assert.equal(originHeaderAllowed("http://100.64.0.1:9999"), false, "wrong port");
});

test("another tailnet's name is not automatically trusted", () => {
  // `*.ts.net` is accepted by suffix ONLY as a fallback for when we could not
  // read our own MagicDNS name. We read it above, so the exact name is required.
  assert.equal(originHeaderAllowed("https://someone-else.other-tailnet.ts.net"), false);
});

test("a missing Origin is allowed; the literal string \"null\" is not", () => {
  // Absent = a non-browser client (curl, the e2e scripts, the hook sink).
  // "null" is a real value a sandboxed iframe or a file:// page sends, and it
  // is exactly the caller this gate exists to refuse.
  assert.equal(originHeaderAllowed(undefined), true);
  assert.equal(originHeaderAllowed("null"), false);
});

test("the Host header is checked too — that is the rebinding guard", () => {
  // A DNS name the attacker controls, resolved to our address, arrives with a
  // perfectly ordinary same-origin Origin. Only the Host header shows it.
  assert.equal(hostHeaderAllowed("100.64.0.1:8770"), true);
  assert.equal(hostHeaderAllowed("127.0.0.1:8770"), true);
  assert.equal(hostHeaderAllowed("rebind.attacker.example:8770"), false);
  assert.equal(hostHeaderAllowed(undefined), true, "HTTP/1.0 has no name to rebind");
});

test("sec-fetch-site is the backstop for an Origin-less cross-origin GET", () => {
  // An <img src> or <script src> on a malicious page carries no Origin, so a
  // side-effecting GET would otherwise sail straight through.
  const v = checkRequestOrigin(
    { host: "100.64.0.1:8770", "sec-fetch-site": "cross-site" },
    { path: "/api/repos", method: "GET" },
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /sec-fetch-site/);
});

test("…and it is not consulted when there IS an Origin to judge", () => {
  // Applying it unconditionally would veto an origin the operator deliberately
  // configured, which is the one case a genuine cross-origin call must work.
  const v = checkRequestOrigin({
    origin: "http://100.64.0.1:8770",
    host: "100.64.0.1:8770",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(v.ok, true);
});

test("the two opaque read routes are exempt — safe methods only", () => {
  // The Android shell loads these as <img src> / <a download>: no Origin,
  // sec-fetch-site cross-site. Refusing them killed every thumbnail and every
  // download in the APK. They are pure reads, and the page still cannot read
  // the answer (no Origin ⇒ no CORS header ⇒ an opaque response).
  const headers = { host: "100.64.0.1:8770", "sec-fetch-site": "cross-site" };
  assert.equal(checkRequestOrigin(headers, { path: "/api/repos/abc/artifact", method: "GET" }).ok, true);
  assert.equal(checkRequestOrigin(headers, { path: "/api/repos/abc/inbox/shot.png", method: "GET" }).ok, true);

  assert.equal(checkRequestOrigin(headers, { path: "/api/repos/abc/inbox/shot.png", method: "DELETE" }).ok, false,
    "a delete is not a read, exempt route or not");
  assert.equal(checkRequestOrigin(headers, { path: "/api/repos/abc/artifact/../../etc", method: "GET" }).ok, false,
    "the exemption is named exactly, never 'any GET under /api/repos'");
});

test("the WS upgrade is judged strictly — it passes no path", () => {
  assert.equal(checkRequestOrigin({ host: "100.64.0.1:8770", "sec-fetch-site": "cross-site" }).ok, false);
});

test("CORS reflects one caller, and never a wildcard", () => {
  // The blanket `access-control-allow-origin: *` this replaced let any page
  // read the API.
  const ok = corsHeaders({ origin: "http://100.64.0.1:8770" });
  assert.equal(ok["access-control-allow-origin"], "http://100.64.0.1:8770");
  assert.notEqual(ok["access-control-allow-origin"], "*");
  assert.equal(ok["timing-allow-origin"], "http://100.64.0.1:8770",
    "in the APK every image is cross-origin; without this the phone under-counts its own data use");
  assert.match(ok["access-control-expose-headers"], /Content-Range/,
    "a resumed download reads content-range, and cannot without this");

  assert.deepEqual(corsHeaders({ origin: "https://evil.example.com" }), {},
    "a refused origin gets no CORS headers at all");
});

// The gates read the raw path, the router the normalised one: a path the two
// read differently must never get past the first gate (it would be judged as
// the token-exempt /api/peer/* and served as a core route).
test("a non-canonical request path is refused, a canonical one passes unchanged", async () => {
  const { canonicalRequestPath } = await import("../dist/origin.js");
  for (const bad of ["/api/peer/../repos/x/tree/file", "/api/peer/%2e%2e/repos/x", "/api/peer/%2E%2E/plugin/echo/ping",
    "/api/peer/./x", "/api\\peer/x", "//api/../api/x"]) {
    assert.equal(canonicalRequestPath(bad), null, bad);
  }
  for (const [url, p] of [["/api/health", "/api/health"], ["/api/repos/a%20b/inbox/x%2Fy?seen=1", "/api/repos/a%20b/inbox/x%2Fy"],
    ["/", "/"], [undefined, "/"], ["/api/peer/jobs", "/api/peer/jobs"], ["/assets/index-abc.js", "/assets/index-abc.js"]]) {
    assert.equal(canonicalRequestPath(url), p, String(url));
  }
});
