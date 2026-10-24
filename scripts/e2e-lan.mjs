// LAN identity + device tokens through a live host.
//
// Phase A (bound on loopback): the identity is served to the trusted path, the
// verify MAC is the HMAC the phone will compute, `/api/auth/token` refuses
// until a password is set and then mints, a Bearer / `<ws>-tok.<tok>`
// subprotocol are recognised (welcome.deviceId, `current` in the list), verify
// is rate-limited, and a revoke closes that device's socket.
//
// Phase B (the SAME root, restarted, bound on this machine's LAN address under
// <ENV>_ALLOW_PUBLIC=1 — skipped, in words, when there is none): tokens survived
// the restart, no token ⇒ 401 / authRequired, Bearer and subprotocol are
// accepted, a LAN token does NOT unlock the identity, verify still answers
// pre-auth, a preflight passes the token gate, and a revoke kills a token at once.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, WS_PROTOCOL, rootEnv } from "./lib-brand.mjs";

const PORT = 8812;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const baseEnv = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT),
  ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
delete baseEnv[E.ALLOW_PUBLIC];

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
let host = null;
const boot = (env) => {
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return host;
};
const stop = () => new Promise((r) => { if (!host || host.exitCode !== null) return r(); host.once("exit", r); host.kill(); });
const finish = async () => { await stop(); process.exit(failed ? 1 : 0); };

const nonce = () => randomBytes(18).toString("base64url");
const mac = (secret, hostId, n) => createHmac("sha256", secret).update(`${hostId}\n${n}`).digest("hex");

async function http(addr, path, { method = "GET", headers = {}, body } = {}) {
  const r = await fetch(`http://${addr}:${PORT}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, json };
}
const bearer = (tok) => ({ authorization: `Bearer ${tok}` });

/** Open a socket; resolve with the first welcome/authRequired and the socket. */
function openWs(addr, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${addr}:${PORT}/ws`, protocols);
    const t = setTimeout(() => resolve({ ws, first: "timeout" }), 4000);
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === "welcome" || msg.t === "authRequired") { clearTimeout(t); resolve({ ws, first: msg }); }
    });
    ws.on("error", () => { clearTimeout(t); resolve({ ws, first: "error" }); });
  });
}
const closed = (ws) => new Promise((r) => { if (ws.readyState === WebSocket.CLOSED) return r(true); ws.once("close", () => r(true)); setTimeout(() => r(false), 3000); });

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const p = a.address.split(".").map(Number);
      if (p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)) return a.address;
    }
  }
  return null;
}

async function phaseA() {
  const L = "127.0.0.1";
  const id = await http(L, "/api/lan/identity");
  check(id.status === 200 && /^[a-z0-9]{4,16}$/.test(id.json?.hostId ?? "") && (id.json?.secret ?? "").length >= 32, "identity served on loopback");
  const n = nonce();
  const v = await http(L, "/api/lan/verify", { method: "POST", body: { nonce: n } });
  check(v.status === 200 && v.json?.hostId === id.json.hostId, "verify answers with this host's id");
  check(v.json?.mac === mac(id.json.secret, id.json.hostId, n), "verify MAC = HMAC-SHA256(secret, hostId\\nnonce)");
  check((await http(L, "/api/lan/verify", { method: "POST", body: { nonce: "short" } })).status === 400, "verify refuses an out-of-bounds nonce");

  const early = await http(L, "/api/auth/token", { method: "POST", body: { deviceName: "e2e" } });
  check(early.status === 403, "token mint refused while no password is set (deny-until-set)");

  // Set the password from the trusted path, over the socket, as Settings does.
  const { ws: mgr } = await openWs(L);
  mgr.send(JSON.stringify({ t: "auth.set", password: "e2e-lan-password" }));
  await new Promise((r) => setTimeout(r, 300));
  mgr.close();

  const nameless = await http(L, "/api/auth/token", { method: "POST", body: {} });
  check(nameless.status === 400, "token mint needs a deviceName");
  const m1 = await http(L, "/api/auth/token", { method: "POST", body: { deviceName: "phone one" } });
  const m2 = await http(L, "/api/auth/token", { method: "POST", body: { deviceName: "phone two" } });
  const m3 = await http(L, "/api/auth/token", { method: "POST", body: { deviceName: "phone three" } });
  check(m1.status === 200 && typeof m1.json?.token === "string" && typeof m1.json?.deviceId === "string", "trusted caller mints a device token");
  check(m1.headers.get("cache-control") === "no-store", "token response is not cacheable");

  const list = await http(L, "/api/devices", { headers: bearer(m1.json.token) });
  const cur = list.json?.devices?.filter((d) => d.current) ?? [];
  check(list.status === 200 && list.json.devices.length === 3, "device list has the three rows");
  check(cur.length === 1 && cur[0].id === m1.json.deviceId, "Bearer marks the caller's row current");
  check(list.json.devices.every((d) => !("tokenHash" in d) && !("token" in d)), "list never carries a token or hash");

  const sub = await openWs(L, [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${m1.json.token}`]);
  check(sub.first?.t === "welcome" && sub.first.deviceId === m1.json.deviceId, "subprotocol token recognised (welcome.deviceId)");
  check(sub.ws.protocol === WS_PROTOCOL, "host echoes the base subprotocol, never the token");
  check(sub.first?.hostId === id.json.hostId && typeof sub.first?.hostName === "string", "welcome carries hostId + hostName");
  sub.ws.close();

  // Revoke device three while its socket is open.
  const s3 = await openWs(L, [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${m3.json.token}`]);
  const rv = await http(L, "/api/devices/revoke", { method: "POST", body: { id: m3.json.deviceId } });
  check(rv.status === 200 && rv.json?.revoked === true && rv.json?.closedSockets === 1, "revoke deletes the row and closes its socket");
  check(await closed(s3.ws), "the revoked device's socket is closed");
  const again = await http(L, "/api/devices/revoke", { method: "POST", body: { id: m3.json.deviceId } });
  check(again.json?.revoked === false, "a second revoke says it was already gone");
  const after = await openWs(L, [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${m3.json.token}`]);
  check(after.first?.t === "welcome" && after.first.deviceId === undefined, "revoked token is no longer a device");
  after.ws.close();

  // Rate limit: the bucket is 10 deep and we have spent 2.
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await http(L, "/api/lan/verify", { method: "POST", body: { nonce: nonce() } });
    if (r.status === 429) { limited = !!r.headers.get("retry-after"); break; }
  }
  check(limited, "verify is rate-limited per remote IP (429 + retry-after)");
  return { t1: m1.json, t2: m2.json, hostId: id.json.hostId, secret: id.json.secret };
}

async function waitLan(addr) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://${addr}:${PORT}/api/health`); if (r.status === 401 || r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function phaseB(a) {
  const lan = lanAddress();
  if (!lan) { console.log("SKIP: phase B — this machine has no private LAN IPv4 to bind"); return; }
  boot({ ...baseEnv, [E.HOST]: lan, [E.ALLOW_PUBLIC]: "1" });
  if (!(await waitLan(lan))) { check(false, `host came up on ${lan}`); return; }

  const bare = await http(lan, "/api/health");
  check(bare.status === 401 && bare.json?.authRequired === true, "LAN without a token → 401");
  check((await http(lan, "/api/health", { headers: bearer("not-a-real-token") })).status === 401, "LAN with a wrong token → 401");
  check((await http(lan, "/api/health", { headers: bearer(a.t1.token) })).status === 200, "Bearer token survived the restart and is accepted over LAN");
  const lanMint = await http(lan, "/api/auth/token", { method: "POST", headers: bearer(a.t1.token), body: { deviceName: "bred over wifi" } });
  check(lanMint.status === 403 && /never from the Wi-Fi route/.test(lanMint.json?.error ?? ""), "a LAN token cannot mint another device token (403)");

  const pre = await http(lan, "/api/health", { method: "OPTIONS", headers: { origin: `http://${lan}:${PORT}`, "access-control-request-headers": "authorization" } });
  check(pre.status === 204 && /authorization/i.test(pre.headers.get("access-control-allow-headers") ?? ""), "preflight passes the token gate and allows Authorization");

  const noTok = await openWs(lan, [WS_PROTOCOL]);
  check(noTok.first?.t === "authRequired", "LAN socket without a token → authRequired");
  noTok.ws.close();
  const s1 = await openWs(lan, [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${a.t1.token}`]);
  check(s1.first?.t === "welcome" && s1.first.deviceId === a.t1.deviceId && s1.first.clientKind === "lan", "LAN socket with the subprotocol token → welcome");
  const s2 = await openWs(lan, [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${a.t2.token}`]);
  check(s2.first?.t === "welcome" && s2.first.deviceId === a.t2.deviceId, "second device's socket accepted");

  check((await http(lan, "/api/lan/identity", { headers: bearer(a.t1.token) })).status === 403, "a LAN token does NOT unlock the identity (403)");
  const n = nonce();
  const v = await http(lan, "/api/lan/verify", { method: "POST", body: { nonce: n } });
  check(v.status === 200 && v.json?.mac === mac(a.secret, a.hostId, n), "verify answers pre-auth over LAN with the right MAC");

  const list = await http(lan, "/api/devices", { headers: bearer(a.t1.token) });
  const me = list.json?.devices?.find((d) => d.id === a.t1.deviceId);
  // lastKind stays "loopback" here: it was minted under a minute ago, and
  // lastSeen/lastKind are written at most once per DEVICE_SEEN_THROTTLE_MS.
  check(me?.current === true && me.lastKind === "loopback", "device list over LAN: current marked, lastSeen throttled");
  check((await http(lan, "/api/devices")).status === 401, "device list without a token → 401");
  check((await http(lan, "/api/devices/revoke", { method: "POST", body: { id: a.t2.deviceId } })).status === 401, "revoke without a token → 401");

  const rv = await http(lan, "/api/devices/revoke", { method: "POST", headers: bearer(a.t1.token), body: { id: a.t2.deviceId } });
  check(rv.json?.revoked === true && rv.json?.closedSockets === 1, "revoke over LAN closes the other device's socket");
  check(await closed(s2.ws), "revoked socket closed");
  check((await http(lan, "/api/health", { headers: bearer(a.t2.token) })).status === 401, "revoked token → 401 at once");
  check((await http(lan, "/api/health", { headers: bearer(a.t1.token) })).status === 200, "the other token still works");
  s1.ws.close();
}

boot({ ...baseEnv, [E.HOST]: "127.0.0.1" });
bootWait(PORT, 600, async () => {
  try {
    const a = await phaseA();
    await stop();
    await phaseB(a);
  } catch (e) {
    console.error(e);
    failed = true;
  }
  await finish();
});
