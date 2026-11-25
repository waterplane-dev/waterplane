// R-security-034, against a live host: a page under a name the local network answers for (this
// desktop's own `.local`, an ALLOWED_HOSTS alias) reaches nothing without a token, whether it rebinds
// the name to loopback (Host) or calls 127.0.0.1 outright (Origin). Two names and a fake resolver: the
// requests really go to `<name>:<port>`, with a `lookup` that answers 127.0.0.1, as the attacker's DNS does.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { Agent, request } from "node:http";
import { connect } from "node:net";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";
import { watchdog } from "./lib-watchdog.mjs";
import { E, rootEnv } from "./lib-brand.mjs";
import { BRAND } from "../packages/shared/dist/brand.js";

watchdog(() => { console.error("FAIL: hung"); process.exit(1); }, 90_000);
const SELF = `${hostname().toLowerCase().replace(/\.local$/, "").split(".")[0]}.local`;
const h = await bootHost({ quiet: true, tag: "rebind", env: { [E.ALLOWED_HOSTS]: "box.home.arpa,alias.home.arpa", [E.ALLOWED_ORIGINS]: "https://box.home.arpa" } });
const PORT = h.port;
let failed = false;
let named = "";
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

const toLoopback = (_name, opts, cb) => (opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
function ask(name, path, { method = "GET", headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: name, port: PORT, path, method, headers, agent, lookup: toLoopback }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, port: req.socket.localPort }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}
/** The first frame that says whether the socket was let in, or how it closed. */
function ws(name, headers = {}, then) {
  return new Promise((resolve) => {
    const s = new WebSocket(`ws://${name}:${PORT}/ws`, { headers, lookup: toLoopback });
    const end = (v) => { try { s.close(); } catch { /* closing */ } resolve(v); };
    s.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (then && msg.t === "welcome") { then(s, end); return; }
      if (msg.t === "welcome") end(`welcome ${msg.clientKind}`);
      if (msg.t === "authRequired") end(`authRequired ${msg.kind}`);
    });
    s.on("close", (c) => resolve(`closed ${c}`));
    s.on("error", () => resolve("error"));
  });
}
/** Raw bytes on one socket: the request shapes no client library will send. */
function bytes(text) {
  return new Promise((resolve) => {
    const s = connect(PORT, "127.0.0.1", () => s.write(text));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
  });
}
const statuses = (out) => [...out.matchAll(/^HTTP\/1\.1 (\d+)/gm)].map((m) => Number(m[1]));

try {
  const page = { origin: `http://${SELF}:${PORT}` };
  // ── rebinding: the name points at loopback ──
  for (const name of [SELF, "alias.home.arpa", "box.home.arpa"]) {
    check((await ask(name, "/api/health")).status === 401, `${name}: GET /api/health needs a token`);
    check((await ask(name, "/api/auth/status")).json?.kind === "unknown", `${name}: not loopback, not tailnet`);
    check((await ask(name, "/api/auth/status")).json?.canManage === false, `${name}: may not manage the password`);
    check(await ws(name, { origin: `http://${name}:${PORT}` }) === "authRequired unknown", `${name}: the socket is refused`);
    check(await ws(name) === "authRequired unknown", `${name}: without an Origin too`);
    for (const forged of [{ "x-forwarded-for": "100.64.0.9" }, { "tailscale-user-login": "a@b", "x-forwarded-proto": "https" }]) {
      check((await ask(name, "/api/health", { headers: forged })).status === 401, `${name}: a forged ${Object.keys(forged)[0]} buys nothing`);
    }
    check((await ask(name, "/api/repos/deadbeef/artifact?path=x.png", { headers: { "sec-fetch-site": "cross-site" } })).status === 401, `${name}: the opaque read routes too`);
    check((await ask(name, "/api/hook", { method: "POST", body: "{}" })).status === 401, `${name}: the hook sink`);
    check((await ask(name, "/api/peers")).status === 401, `${name}: the peer list`);
    check((await ask(name, "/api/lan/identity")).status === 403, `${name}: the LAN identity secret`);
    check((await ask(name, "/api/tailnet/peers")).status === 401, `${name}: the tailnet map`);
    check((await ask(name, "/api/pair/mint", { method: "POST", body: "{}" })).status === 401, `${name}: makes no pairing code`);
  }
  // ── no rebinding: the page calls 127.0.0.1 by address ──
  for (const origin of [`http://${SELF}`, `http://${SELF}:${PORT}`, "http://alias.home.arpa"]) {
    check(await ws("127.0.0.1", { origin }) === "authRequired unknown", `Origin ${origin} on 127.0.0.1: the socket is refused`);
    check((await ask("127.0.0.1", "/api/health", { headers: { origin } })).status === 401, `Origin ${origin}: the API too`);
    check((await ask("127.0.0.1", "/api/hook", { method: "POST", body: "{}", headers: { origin, "content-type": "text/plain" } })).status === 401, `Origin ${origin}: the hook sink`);
  }
  // ── the shapes no browser sends ──
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const first = await ask("127.0.0.1", "/api/health", { agent });
  const second = await ask("127.0.0.1", "/api/health", { agent, headers: { host: `${SELF}:${PORT}` } });
  const third = await ask("127.0.0.1", "/api/health", { agent });
  agent.destroy();
  check(first.port === third.port && second.port === first.port, "three requests on one kept-alive socket");
  check(first.status === 200 && second.status === 401 && third.status === 200, "each judged by its own Host");
  const end = "\r\nconnection: close\r\n\r\n";
  check(String(statuses(await bytes(`GET http://127.0.0.1:${PORT}/api/health HTTP/1.1\r\nhost: ${SELF}${end}`))) === "400", "an absolute-form URI is refused");
  check(String(statuses(await bytes(`GET /api/health HTTP/1.1\r\nhost: ${SELF}:${PORT}\r\nhost: 127.0.0.1${end}`))).match(/^40[01]$/) !== null, "two Hosts, the name first");
  check(String(statuses(await bytes(`GET /api/health HTTP/1.1\r\nHOST: ${SELF.toUpperCase()}.:${PORT}${end}`))) === "401", "upper case and a trailing dot");
  check(String(statuses(await bytes(`GET /api/health HTTP/1.1${end}`))) === "400", "HTTP/1.1 without a Host is refused");
  check(String(statuses(await bytes(`GET /api/health HTTP/1.0\r\n\r\n`).then((o) => o.replace("HTTP/1.0", "HTTP/1.1")))) === "200", "HTTP/1.0 without one is a local process");
  check(String(statuses(await bytes(`GET http://127.0.0.1:${PORT}/ws HTTP/1.1\r\nhost: ${SELF}\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n`))) === "400", "an absolute-form upgrade is refused");

  // ── what must keep working ──
  check((await ask("localhost", "/api/health")).status === 200, "localhost");
  check((await ask("127.0.0.1", "/api/health")).status === 200, "127.0.0.1, no Origin (curl, the scripts)");
  check((await ask("127.0.0.1", "/api/hook", { method: "POST", body: '{"session_id":"none"}', headers: { "content-type": "application/json" } })).status === 204, "the hook sink, from a local process");
  check(await ws("127.0.0.1", { origin: "http://localhost" }) === "welcome loopback", "the Android app's origin");
  check(await ws("127.0.0.1", { origin: "capacitor://localhost" }) === "welcome loopback", "the iOS app's origin");
  check((await ask("127.0.0.1", "/api/health", { headers: { host: "box.home.arpa", origin: "https://box.home.arpa", "x-forwarded-for": "10.0.0.9" } })).status === 200, "a reverse proxy whose https origin is listed");
  check((await ask("127.0.0.1", "/api/health", { headers: { host: "alias.home.arpa", "x-forwarded-for": "10.0.0.9" } })).status === 401, "one whose origin is not: a token");
  check((await ask("127.0.0.1", "/api/health", { headers: { host: "box.home.arpa", origin: "http://box.home.arpa", "x-forwarded-for": "10.0.0.9" } })).status === 401, "a plain-http page under that name never met the certificate: a token");

  // ── the name keeps its route: with a password it signs in, like a Wi-Fi client ──
  const set = await ws("127.0.0.1", {}, (s, done) => {
    s.on("message", (m) => { const msg = JSON.parse(m.toString()); if (msg.t === "auth.state") done(msg.auth.enabled); });
    s.send(JSON.stringify({ t: "auth.set", password: "correct horse battery" }));
  });
  check(set === true, "a password is set from loopback");
  check((await ask(SELF, "/api/health", { headers: page })).status === 401, "the name alone is still refused");
  const login = await ask(SELF, "/api/auth/login", { method: "POST", body: JSON.stringify({ password: "correct horse battery" }), headers: { "content-type": "application/json", ...page } });
  const cookie = named = String(login.headers["set-cookie"] ?? "").split(";")[0];
  check(login.status === 200 && cookie.startsWith(`${BRAND.cookie}=`), "the password signs in under the name");
  const attrs = String(login.headers["set-cookie"]);
  check(/HttpOnly/.test(attrs) && /SameSite=Lax/.test(attrs) && !/Domain=/i.test(attrs) && /Max-Age=43200\b/.test(attrs), "a cookie for this exact name, 12 hours");
  check((await ask(SELF, "/api/health", { headers: { cookie } })).status === 200, "and the API answers");
  const tok = cookie.split("=")[1];
  const funnel = { host: "127.0.0.1", "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.5" };
  check((await ask("127.0.0.1", "/api/health", { headers: { ...funnel, cookie } })).status === 401, "replayed from elsewhere (Funnel) the cookie is nothing");
  check((await ask("127.0.0.1", "/api/health", { headers: { ...funnel, authorization: `Bearer ${tok}` } })).status === 401, "nor as a bearer");
  const row = (await ask("127.0.0.1", "/api/devices")).json?.devices?.find((d) => d.under === SELF);
  check(!!row, "the device list says the name");
  check(await ws(SELF, { ...page, cookie }) === "welcome unknown", "and the socket");
  check((await ask(SELF, "/api/auth/token", { method: "POST", body: '{"deviceName":"x"}', headers: { cookie, "content-type": "application/json" } })).status === 403, "but mints no token");
  const trusted = await ask("127.0.0.1", "/api/auth/token", { method: "POST", body: '{"deviceName":"x"}', headers: { "content-type": "application/json" } });
  check(trusted.status === 200, "which loopback does");
  check((await ask("127.0.0.1", "/api/health", { headers: { ...funnel, authorization: `Bearer ${trusted.json.token}` } })).status === 200, "a device token counts on every route, as before");
  check((await ask(SELF, "/api/pair/mint", { method: "POST", body: "{}", headers: { cookie, "content-type": "application/json" } })).status === 403, "makes no pairing code");
  check((await ask("127.0.0.1", "/api/pair/mint", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status === 200, "which loopback does");
  check((await ask(SELF, "/api/peers", { headers: { cookie } })).status === 403, "and manages no peers");
  check((await ask(SELF, "/api/hook", { method: "POST", body: "{}", headers: { cookie, "content-type": "application/json" } })).status === 403, "and is no process on this desktop");
  const refused = await ws(SELF, { ...page, cookie }, (s, done) => {
    s.on("message", (m) => { const msg = JSON.parse(m.toString()); if (msg.t === "error" && msg.context === "auth") done("refused"); });
    s.send(JSON.stringify({ t: "auth.set", password: "another password" }));
  });
  check(refused === "refused", "and changes no password");
  // A flood under the name spends its own bucket, never the desktop's sign-in.
  for (let i = 0; i < 14; i++) await ask(SELF, "/api/auth/login", { method: "POST", body: '{"password":"wrong wrong"}', headers: { "content-type": "application/json", "x-forwarded-for": `9.9.9.${i}` } });
  check((await ask(SELF, "/api/auth/login", { method: "POST", body: '{"password":"wrong wrong"}', headers: { "content-type": "application/json", "x-forwarded-for": "9.9.8.8" } })).status === 429, "guesses under the name are held, whatever source they claim");
  check((await ask("127.0.0.1", "/api/auth/login", { method: "POST", body: JSON.stringify({ password: "correct horse battery" }), headers: { "content-type": "application/json" } })).status === 200, "the desktop's own sign-in is not");
} catch (e) {
  console.error(e);
  failed = true;
}
await h.stop();
// ── the sign-in under the name ends by itself, the open socket with it ──
try {
  const dir = readdirSync(h.root).find((d) => { try { return readFileSync(join(h.root, d, "devices.json")).length > 0; } catch { return false; } });
  const file = join(h.root, dir, "devices.json");
  const led = JSON.parse(readFileSync(file, "utf8"));
  const row = led.devices.find((d) => d.under === SELF);
  row.createdAt = Date.now() - 12 * 3_600_000 + 12_000; // 12 s to go
  writeFileSync(file, JSON.stringify(led));
  const h2 = await bootHost({ quiet: true, tag: "rebind2", env: rootEnv(h.root) });
  try {
    const cookie = named;
    const end = await new Promise((resolve) => {
      const s = new WebSocket(`ws://${SELF}:${h2.port}/ws`, { headers: { cookie, origin: `http://${SELF}:${h2.port}` }, lookup: toLoopback });
      const seen = [];
      s.on("message", (m) => { const t = JSON.parse(m.toString()).t; if (t === "welcome" || t === "authRequired") seen.push(t); });
      s.on("close", () => resolve(seen.join(" ")));
      s.on("error", () => resolve("error"));
    });
    check(end === "welcome authRequired", `an open socket is told and closed when its sign-in ends (${end})`);
  } finally { await h2.stop(); }
} catch (e) {
  console.error(e);
  failed = true;
}
process.exit(failed ? 1 : 0);
