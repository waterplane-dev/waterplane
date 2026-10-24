// Passive devices through a live host (`passive.ts`, R-connection-011…014),
// bound on loopback. A loopback caller needs no token, but a passive token it
// PRESENTS is still held to the allowlist — which is what lets this run here.
//
// Set a password → mint a passive code → redeem: the token is passive and the
// Tailscale gate is on → refused on a non-allowlisted route and on the WS,
// allowed on health, the web bundle, its state and the artifact of a queued APK
// (and refused on a non-queued file of the same repo) → it cannot set the PIN
// or mint a full token → the PIN is set from the trusted path → a wrong PIN is
// refused, the right one unlocks: the route and the WS open → after the
// shortened unlock (<ENV>_PASSIVE_UNLOCK_MS) the socket is closed and the
// route refused again. "Lock now" ends an unlock at once.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, WS_PROTOCOL, rootEnv } from "./lib-brand.mjs";

const PORT = 8819;
const UNLOCK_MS = 2500;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-passive-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT),
  ...rootEnv(ROOT),
  [E.HOST]: "127.0.0.1",
  [E.PASSIVE_UNLOCK_MS]: String(UNLOCK_MS),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
delete env[E.ALLOW_PUBLIC];

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const open = new Set();
const finish = async () => {
  for (const ws of open) { try { ws.terminate(); } catch { /* gone */ } }
  await new Promise((r) => { if (host.exitCode !== null) return r(); host.once("exit", r); host.kill(); });
  process.exit(failed ? 1 : 0);
};

const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, { method = "GET", tok, body } = {}) {
  const headers = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}) };
  const r = await fetch(B + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json };
}
/** First frame or how the socket ended: "welcome", "closed:<code>", "timeout". */
function openWs(tok) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, tok ? [WS_PROTOCOL, `${WS_PROTOCOL}-tok.${tok}`] : [WS_PROTOCOL]);
    open.add(ws);
    const t = setTimeout(() => resolve({ ws, first: "timeout" }), 4000);
    ws.on("message", (m) => { const msg = JSON.parse(m.toString()); if (msg.t === "welcome") { clearTimeout(t); resolve({ ws, first: "welcome" }); } });
    ws.on("close", (code) => { clearTimeout(t); resolve({ ws, first: `closed:${code}` }); });
    ws.on("error", () => { /* close follows */ });
  });
}
const closedWithin = (ws, ms) => new Promise((r) => {
  if (ws.readyState === WebSocket.CLOSED) return r(true);
  const t = setTimeout(() => r(false), ms);
  ws.once("close", () => { clearTimeout(t); r(true); });
});
/** One trusted (loopback, no token) WS round-trip. */
function ask(msg, want, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    open.add(ws);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("timeout waiting for " + JSON.stringify(msg))); }, timeout);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "welcome") { ws.send(JSON.stringify(msg)); return; }
      if (want(m)) { clearTimeout(timer); ws.close(); resolve(m); }
    });
    ws.on("error", reject);
  });
}

bootWait(PORT, 900, async () => {
  try {
    // ── a repo with an APK in the auto-pull queue, and a file that is not ──
    await api("/api/repo", { method: "POST", body: { name: "kidsapp" } });
    const target = (await api("/api/repos")).json.targets[0];
    const { id: repoId, worktreePath: wt } = target;
    await ask({ t: "pull.save", repoDir: wt, config: { enabled: true, scope: "outbox", match: ["*.apk"], maxBytes: 4 * 1024 * 1024, builds: true } },
      (m) => m.t === "pull.config" && m.repoDir === wt);
    const outbox = join(wt, ".claude", "outbox");
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, "kids.apk"), Buffer.from("PK\u0003\u0004 apk bytes " + "x".repeat(2048)));
    writeFileSync(join(wt, "secret.txt"), "not for the kids' phone");
    await ask({ t: "pull.add", repoId, relPath: ".claude/outbox/kids.apk" }, (m) => m.t === "pull.list" && m.items.some((i) => i.name === "kids.apk"));
    const apkUrl = `/api/repos/${repoId}/artifact?path=${encodeURIComponent(".claude/outbox/kids.apk")}&download=1`;
    const secretUrl = `/api/repos/${repoId}/artifact?path=secret.txt`;

    // ── password, then a passive pairing ──
    await ask({ t: "auth.set", password: "e2e-passive-password" }, (m) => m.t === "auth.state" && m.auth.enabled);
    const m1 = await api("/api/pair/mint", { method: "POST", body: { passive: true } });
    check(m1.status === 200 && m1.json?.passive === true, "a passive code is minted");
    const r1 = await api("/api/pair/redeem", { method: "POST", body: { code: m1.json.code, deviceName: "kids phone" } });
    const kid = r1.json?.token;
    check(r1.status === 200 && typeof kid === "string" && r1.json.scope === "passive", "redeem hands out a passive token");
    const st = await api("/api/auth/status", { tok: kid });
    check(st.json?.scope === "passive" && st.json?.gateTailscale === true && st.json?.pinSet === false, "status: passive, Tailscale gated, no PIN yet");

    // Behind `tailscale serve` a tailnet request arrives from loopback with proxy
    // headers: with the gate on, it needs a token like any Tailscale peer.
    const proxied = await fetch(B + "/api/repos", { headers: { "x-forwarded-for": "100.100.1.2", "tailscale-user-login": "kid@example" } });
    check(proxied.status === 401, `a tokenless request through tailscale serve is refused (${proxied.status})`);

    // ── locked: default deny ──
    check((await api("/api/repos", { tok: kid })).status === 403, "refused on a non-allowlisted route");
    check((await api("/api/devices", { tok: kid })).status === 403, "refused on the device list");
    check((await api("/api/pair/mint", { method: "POST", tok: kid, body: {} })).status === 403, "refused minting a pairing code");
    check((await api(secretUrl, { tok: kid })).status === 403, "refused a repo file that is not a queued APK");
    const w0 = await openWs(kid);
    check(w0.first === "closed:4403", `refused on the WebSocket (${w0.first})`);
    check((await api("/api/health", { tok: kid })).status === 200, "allowed: health");
    check((await api("/api/webbundle", { tok: kid })).status !== 403, "allowed: the web-bundle manifest");
    const ps = await api("/api/passive/state", { tok: kid });
    check(ps.status === 200 && ps.json.items.length === 1 && ps.json.items[0].name === "kids.apk" && ps.json.unlockedUntil === null, "allowed: its state, listing the queued APK");
    const dl = await fetch(B + apkUrl, { headers: { authorization: `Bearer ${kid}` } });
    check(dl.status === 200 && (await dl.arrayBuffer()).byteLength > 2048, "allowed: the queued APK's download");
    check((await api("/api/auth/token", { method: "POST", tok: kid, body: { deviceName: "sneaky" } })).status === 403, "a passive token cannot mint a full one");
    check((await api("/api/auth/pin", { method: "POST", tok: kid, body: { pin: "1234" } })).status === 403, "a passive token cannot set the PIN");
    check((await api("/api/auth/unlock", { method: "POST", tok: kid, body: { pin: "1234" } })).json?.error === "no-pin", "no PIN set ⇒ unlock says so");

    // ── the PIN from the trusted path, then unlock ──
    const setPin = await api("/api/auth/pin", { method: "POST", body: { pin: "4711" } });
    check(setPin.status === 200 && setPin.json.pinSet === true, "the PIN is set from the trusted path");
    check((await api("/api/auth/unlock", { method: "POST", tok: kid, body: { pin: "0000" } })).status === 403, "a wrong PIN is refused");
    check((await api("/api/repos", { tok: kid })).status === 403, "…and changes nothing");
    const un = await api("/api/auth/unlock", { method: "POST", tok: kid, body: { pin: "4711" } });
    check(un.status === 200 && un.json.unlockedUntil > Date.now(), "the right PIN unlocks, until a time");
    check((await api("/api/repos", { tok: kid })).status === 200, "unlocked: the route opens");
    check((await api("/api/auth/status", { tok: kid })).json?.unlockedUntil === un.json.unlockedUntil, "status says until when");
    const w1 = await openWs(kid);
    check(w1.first === "welcome", `unlocked: the WebSocket opens (${w1.first})`);
    check((await api("/api/auth/token", { method: "POST", tok: kid, body: { deviceName: "sneaky" } })).status === 403, "unlocked or not, it never mints a full token");
    // Auth material stays out of reach while unlocked: each of these would outlive the 30 minutes.
    check((await api("/api/pair/mint", { method: "POST", tok: kid, body: {} })).status === 403, "unlocked or not, it never mints a pairing code");
    check((await api("/api/devices/revoke", { method: "POST", tok: kid, body: { id: "d-0000000000" } })).status === 403, "unlocked or not, it never revokes a device");
    check((await api("/api/peers", { method: "POST", tok: kid, body: { name: "pc", addr: "http://127.0.0.1:1" } })).status === 403, "unlocked or not, it never pairs a peer");
    check((await api("/api/lan/identity", { tok: kid })).status === 403, "unlocked or not, it never reads the LAN identity secret");
    check((await api("/api/repos", { tok: kid })).status === 200, "…while the rest of full scope still answers");
    // Bounded: on a host without the refusal the answer is `auth.state`, never `error`, and a
    // regression must fail in words rather than hang the script.
    const onKidSocket = (ws, msg, want) => new Promise((resolve) => {
      const t = setTimeout(() => { ws.off("message", h); resolve({ t: "timeout" }); }, 3000);
      const h = (raw) => { const m = JSON.parse(raw.toString()); if (want(m)) { clearTimeout(t); ws.off("message", h); resolve(m); } };
      ws.on("message", h); ws.send(JSON.stringify(msg));
    });
    const ga = await onKidSocket(w1.ws, { t: "auth.gateTailscale", enabled: true }, (m) => m.t === "error" && m.context === "auth");
    check(ga.t === "error" && /passive device/.test(ga.message), `unlocked or not, its socket cannot change the password or the gate (${ga.t})`);

    // ── expiry: back to passive, the socket closed ──
    check(await closedWithin(w1.ws, UNLOCK_MS + 2000), "the unlock running out closes its socket");
    check((await api("/api/repos", { tok: kid })).status === 403, "expired: refused again");
    check((await api("/api/auth/status", { tok: kid })).json?.unlockedUntil === undefined, "expired: status is locked");

    // ── Lock now ──
    await sleep(100);
    check((await api("/api/auth/unlock", { method: "POST", tok: kid, body: { pin: "4711" } })).status === 200, "unlock again");
    const lk = await api("/api/auth/lock", { method: "POST", tok: kid, body: {} });
    check(lk.json?.locked === true && (await api("/api/repos", { tok: kid })).status === 403, "Lock now ends it at once");

    // ── the gate cannot be switched off while a passive device is paired ──
    const g = await ask({ t: "auth.gateTailscale", enabled: false }, (m) => m.t === "error" && m.context === "auth");
    check(/passive device/.test(g.message), "switching the Tailscale gate off is refused, in words");
  } catch (e) {
    console.error(e);
    failed = true;
  }
  await finish();
});
