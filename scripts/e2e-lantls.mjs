// TLS on the LAN through a live host: the listener exists exactly where the opt-in put a LAN bind,
// and everything the gate does on the plain port it does on this one.
//
// Phase A, no opt-in, and two ways of having the opt-in without a LAN listener (the off switch; an
// explicit host on loopback): nothing answers on the TLS port, on any address, and no key is minted.
//
// Phase B (<ENV>_ALLOW_PUBLIC=1, the default bind, a temp root — skipped, in words, when this
// machine has no private LAN IPv4): password and tokens set over loopback as Settings does, then
// over TLS on the LAN address: `/api/health` with and without a token, `/ws` with and without one,
// the certificate presented is the one in `lan-tls.json`, loopback and the plain port are not TLS,
// the origin gate holds, and the peer stays `lan` (`/api/lan/identity`, `POST /api/auth/token` refused).
//
// Phase C (the SAME root, restarted): the pin did not move. Phase D: the TLS port taken by someone
// else, then a broken own leaf: the plain host runs regardless, no TLS listener.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { request } from "node:https";
import { createServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";
import { freePort, waitForHost } from "./lib-e2e.mjs";
import { E, SLUG, STATE, WS_PROTOCOL, rootEnv } from "./lib-brand.mjs";
import { watchdog } from "./lib-watchdog.mjs";
import { lanIps } from "../packages/host/dist/net.js";

const newRoot = () => mkdtempSync(join(tmpdir(), `${SLUG}-lantls-`));
const keyFile = (root) => join(root, STATE, "lan-tls.json");

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

let host = null;
let log = "";
const boot = async (port, root, knobs) => {
  log = "";
  const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(port), ...rootEnv(root), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", ...knobs };
  for (const k of [E.ALLOW_PUBLIC, E.HOST, E.TLS, E.TLS_PORT, E.TLS_CERT, E.TLS_KEY]) if (!(k in knobs)) delete env[k];
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", (d) => { log += d; });
  host.stderr.on("data", (d) => { log += d; });
  await waitForHost(port);
};
const stop = () => new Promise((r) => { if (!host || host.exitCode !== null) return r(); host.once("exit", r); host.kill(); });
const finish = async () => { await stop(); process.exit(failed ? 1 : 0); };
watchdog(() => { console.log("FAIL: e2e-lantls hung"); host?.kill("SIGKILL"); process.exit(1); }, 90_000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Until the log says it: a listener is up (or has given up) on its own schedule, never a fixed sleep. */
async function logSays(re, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(log)) return true; await sleep(50); }
  return false;
}

/** Whether anything accepts a TCP connection there. */
const answers = (addr, port) => new Promise((r) => {
  const s = netConnect({ host: addr, port, timeout: 1500 });
  s.once("connect", () => { s.destroy(); r(true); });
  s.once("error", () => r(false));
  s.once("timeout", () => { s.destroy(); r(false); });
});

/** One HTTPS request, by IP, trusting nothing but the check after it. */
function tlsGet(addr, port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: addr, port, path, method, rejectUnauthorized: false, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text, headers: res.headers }); });
    });
    req.once("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const bearer = (tok) => ({ authorization: `Bearer ${tok}` });

/** The first frame on a socket, `welcome` or `authRequired`. */
function openWs(url, protocols, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, opts);
    const t = setTimeout(() => resolve({ ws, first: "timeout" }), 4000);
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === "welcome" || msg.t === "authRequired") { clearTimeout(t); resolve({ ws, first: msg }); }
    });
    ws.on("error", () => { clearTimeout(t); resolve({ ws, first: "error" }); });
  });
}

/** What the handshake presents: the SPKI pin, and the leaf. */
const presented = (addr, port, opts = {}) => new Promise((resolve) => {
  const s = tlsConnect({ host: addr, port, rejectUnauthorized: false, ...opts }, () => {
    const x = s.getPeerX509Certificate();
    const pin = createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const verdict = { pin, x, authorized: s.authorized, protocol: s.getProtocol() };
    s.destroy();
    resolve(verdict);
  });
  s.once("error", (e) => resolve({ error: e.code || e.message }));
});

function lanAddress() {
  for (const ip of lanIps()) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)) return ip;
  }
  return null;
}

async function phaseA(lan) {
  for (const [label, knobs] of [
    ["no opt-in", {}],
    ["the off switch", { [E.ALLOW_PUBLIC]: "1", [E.TLS]: "0" }],
    ["opt-in with the host pinned to loopback", { [E.ALLOW_PUBLIC]: "1", [E.HOST]: "127.0.0.1" }],
  ]) {
    const port = await freePort();
    const tlsPort = await freePort();
    const root = newRoot();
    await boot(port, root, { ...knobs, [E.TLS_PORT]: String(tlsPort) });
    check(!(await answers("127.0.0.1", tlsPort)), `${label}: nothing on the TLS port on loopback`);
    if (lan) check(!(await answers(lan, tlsPort)), `${label}: nothing on the TLS port on the LAN address`);
    check(!existsSync(keyFile(root)), `${label}: no key minted`);
    check(!/listening https/.test(log), `${label}: no TLS listener logged`);
    await stop();
  }
}

async function phaseB(lan, root, port, tlsPort) {
  await boot(port, root, { [E.ALLOW_PUBLIC]: "1", [E.TLS_PORT]: String(tlsPort) });
  check(await logSays(/listening https:/), "the TLS listener came up");
  check(!(await answers("127.0.0.1", tlsPort)), "not on loopback: the LAN addresses only");

  // Deny-until-set holds on this port before anything else happens.
  const unset = await tlsGet(lan, tlsPort, "/api/health");
  check(unset.status === 401, `no password set: refused over TLS (${unset.status})`);

  // Password and token from the trusted path, as Settings does.
  const local = `http://127.0.0.1:${port}`;
  const mgr = await openWs(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL]);
  mgr.ws.send(JSON.stringify({ t: "auth.set", password: "e2e-lantls-password" }));
  await sleep(300);
  mgr.ws.close();
  const minted = await (await fetch(`${local}/api/auth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: "tls phone" }) })).json();
  check(typeof minted.token === "string", "a device token minted on the trusted path");
  const tok = minted.token;

  const health = await tlsGet(lan, tlsPort, "/api/health", { headers: bearer(tok) });
  check(health.status === 200 && health.json?.ok !== false, "/api/health over TLS with the token");
  check((await tlsGet(lan, tlsPort, "/api/health")).status === 401, "/api/health over TLS without a token: 401");
  check((await tlsGet(lan, tlsPort, "/api/health", { headers: bearer("not-a-real-token") })).status === 401, "/api/health over TLS with a wrong token: 401");

  // The socket: the same `attachWs`, so `welcome` with a token and `authRequired` without.
  const wss = `wss://${lan}:${tlsPort}/ws`;
  const good = await openWs(wss, [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${tok}`], { rejectUnauthorized: false });
  check(good.first?.t === "welcome", "/ws over TLS with a token: welcome");
  check(good.first?.clientKind === "lan", `a TLS socket from the Wi-Fi is peer kind lan (${good.first?.clientKind})`);
  check(good.ws.protocol === WS_PROTOCOL, "the host echoes the base subprotocol, never the token");
  good.ws.close();
  const bare = await openWs(wss, [WS_PROTOCOL], { rejectUnauthorized: false });
  check(bare.first?.t === "authRequired", "/ws over TLS without a token: refused");
  bare.ws.close();
  const evilWs = await openWs(wss, [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${tok}`], { rejectUnauthorized: false, origin: "https://evil.example.com" });
  check(evilWs.first?.t !== "welcome", "/ws over TLS from a stranger's page: refused, token or not");
  evilWs.ws.close();

  // Peer kind `lan` and everything that follows from it.
  const id = await tlsGet(lan, tlsPort, "/api/lan/identity", { headers: bearer(tok) });
  check(id.status === 403, `/api/lan/identity over TLS: refused, token or not (${id.status})`);
  const breed = await tlsGet(lan, tlsPort, "/api/auth/token", { method: "POST", headers: bearer(tok), body: { deviceName: "bred over tls" } });
  check(breed.status === 403, `POST /api/auth/token over TLS: refused (${breed.status})`);

  // The origin gate, the phone's page, and a rebinding Host.
  const android = await tlsGet(lan, tlsPort, "/api/health", { headers: { ...bearer(tok), origin: "http://localhost" } });
  check(android.status === 200 && android.headers["access-control-allow-origin"] === "http://localhost", "Origin http://localhost passes on the TLS port, reflected, never a wildcard");
  check((await tlsGet(lan, tlsPort, "/api/health", { headers: { ...bearer(tok), origin: "https://evil.example.com" } })).status === 403, "a stranger's Origin: 403 on the TLS port");
  check((await tlsGet(lan, tlsPort, "/api/health", { headers: { ...bearer(tok), host: `evil.example.com:${tlsPort}` } })).status === 403, "a rebinding Host: 403 on the TLS port");

  // A self-signed port serves a plain notice, never the app; the API, /ws and /pair are untouched.
  for (const p of ["/", "/index.html", "/assets/x.js", "/anything/else"]) {
    const page = await tlsGet(lan, tlsPort, p);
    check(page.status === 200 && /This port is for the app/.test(page.text ?? "") && !/<script/i.test(page.text ?? ""), `GET ${p} over self-signed TLS: the notice, not the app (${page.status})`);
  }
  check((await tlsGet(lan, tlsPort, "/", { headers: bearer(tok) })).headers["content-security-policy"]?.includes("default-src 'none'"), "the notice carries the safe headers");
  check(!/This port is for the app/.test((await (await fetch(`http://127.0.0.1:${port}/`)).text())), "the plain port still serves the app (or its 503), never the notice");
  const pairPage = await tlsGet(lan, tlsPort, "/pair/not-a-code");
  check(!/This port is for the app/.test(pairPage.text ?? ""), "/pair/* is the pair page's business, not the notice");

  // Read tickets: minted behind the token gate, honoured as ?wt= only on an opaque read route over TLS.
  check((await tlsGet(lan, tlsPort, "/api/auth/read-ticket", { method: "POST" })).status === 401, "read-ticket without a token: 401");
  const rt = await tlsGet(lan, tlsPort, "/api/auth/read-ticket", { method: "POST", headers: bearer(tok) });
  const wt = rt.json?.ticket;
  check(rt.status === 200 && typeof wt === "string" && rt.json.exp > Date.now(), "read-ticket with a device token: a ticket");
  const q = encodeURIComponent(wt);
  const art = "/api/repos/nope/artifact?path=a.png";
  check((await tlsGet(lan, tlsPort, art)).status === 401, "artifact route without ticket or token: 401");
  check((await tlsGet(lan, tlsPort, `${art}&wt=${q}`)).status !== 401, "artifact route with ?wt= over TLS: past the gate");
  check((await tlsGet(lan, tlsPort, `/api/repos/nope/inbox/a.png?wt=${q}`)).status !== 401, "inbox route with ?wt= over TLS: past the gate");
  check((await tlsGet(lan, tlsPort, `/api/health?wt=${q}`)).status === 401, "?wt= on any other route: 401");
  check((await tlsGet(lan, tlsPort, `${art}&wt=${q}`, { method: "DELETE" })).status === 401, "?wt= on DELETE: 401");
  check((await tlsGet(lan, tlsPort, `${art}&wt=${q.slice(0, -3)}AAA`)).status === 401, "a tampered ticket: 401");
  check((await tlsGet(lan, tlsPort, "/api/health", { headers: bearer(tok) })).status === 200, "/api/health over TLS unaffected");

  // The certificate the phone will pin.
  const stored = JSON.parse(readFileSync(keyFile(root), "utf8"));
  check((statSync(keyFile(root)).mode & 0o777) === 0o600, "lan-tls.json is 0600");
  const leaf = new X509Certificate(stored.cert);
  const shown = await presented(lan, tlsPort);
  const pin = createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  check(shown.pin === pin, "the handshake presents the stored key");
  check(leaf.checkIP(lan) === lan, "the leaf names this LAN address");
  // Standing in for the phone's pin path: the leaf as the only trust anchor, name checked.
  const trusted = await presented(lan, tlsPort, { rejectUnauthorized: true, ca: stored.cert });
  check(trusted.authorized === true, `a real verifier trusting only this leaf accepts it (${trusted.error ?? "ok"})`);
  check((await presented(lan, tlsPort, { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" })).protocol === "TLSv1.2", "TLS 1.2 is served");
  const old = await presented(lan, tlsPort, { minVersion: "TLSv1.1", maxVersion: "TLSv1.1", ciphers: "DEFAULT:@SECLEVEL=0" });
  check(!!old.error, `TLS 1.1 is refused (${old.error})`);
  await stop();
  return { pin, cert: stored.cert, tok };
}

async function phaseC(lan, root, port, tlsPort, first) {
  await boot(port, root, { [E.ALLOW_PUBLIC]: "1", [E.TLS_PORT]: String(tlsPort) });
  check(await logSays(/listening https:/), "restarted: the TLS listener came up");
  check((await presented(lan, tlsPort)).pin === first.pin, "restarted: same pin");
  check(JSON.parse(readFileSync(keyFile(root), "utf8")).cert === first.cert, "restarted, same addresses: the leaf was not re-issued");
  check((await tlsGet(lan, tlsPort, "/api/health", { headers: bearer(first.tok) })).status === 200, "restarted: the token still works over TLS");
  await stop();
}

async function phaseD(lan) {
  // Someone else already holds the port on the LAN address.
  const port = await freePort();
  const squatted = await freePort();
  const squatter = createServer();
  await new Promise((r) => squatter.listen(squatted, lan, r));
  await boot(port, newRoot(), { [E.ALLOW_PUBLIC]: "1", [E.TLS_PORT]: String(squatted) });
  check(await logSays(/carrying on plain/), "a busy TLS port is logged");
  check(host.exitCode === null, "and the daemon stayed up");
  check((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200, "the plain host answers");
  await stop();
  await new Promise((r) => squatter.close(r));

  // A bad own leaf: refuses the listener, says why, and the plain host runs.
  const port2 = await freePort();
  const tlsPort2 = await freePort();
  const root = newRoot();
  await boot(port2, root, { [E.ALLOW_PUBLIC]: "1", [E.TLS_PORT]: String(tlsPort2), [E.TLS_CERT]: "/nonexistent/leaf.pem", [E.TLS_KEY]: "/nonexistent/leaf.key" });
  check(/LAN TLS off: cannot read the certificate/.test(log), "a bad own leaf says why");
  check(!(await answers(lan, tlsPort2)), "and no TLS listener came up");
  check(!existsSync(keyFile(root)), "and it did not fall back to a generated key");
  check((await fetch(`http://127.0.0.1:${port2}/api/health`)).status === 200, "the plain host answers");
  await stop();
}

try {
  const lan = lanAddress();
  await phaseA(lan);
  if (!lan) console.log("SKIP: phases B-D — this machine has no private LAN IPv4 to bind");
  else {
    const root = newRoot();
    const port = await freePort();
    const tlsPort = await freePort();
    const first = await phaseB(lan, root, port, tlsPort);
    await phaseC(lan, root, port, tlsPort, first);
    await phaseD(lan);
  }
} catch (e) {
  check(false, `threw: ${e?.stack || e}`);
  if (log) console.log(`--- host log ---\n${log.slice(-2000)}`);
}
await finish();
