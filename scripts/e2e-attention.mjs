// `GET /api/attention` through a live host (`shared/waiting.ts`, R-connection-030): what this
// desktop waits on a person for, read by a phone switched to ANOTHER desktop.
//
// Asserts:
//   1. a fresh host waits on nothing: sessions.n 0, attention.n 0
//   2. a choice box on a live session ⇒ sessions.n 1, its id listed
//   3. an urgent plugin card (the vault's "approval" kind) ⇒ attention.n 1, a line with no body;
//      the box's own "needs you" item is NOT counted again beside sessions.n
//   4. `notification.handle` on it ⇒ attention.n 0
//   5. a cross-origin browser request is refused (Origin), a rebinding Host too
//   6. a passive (kids') device token is refused the route
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";
import { watchdog } from "./lib-watchdog.mjs";
import { E, SLUG } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); }
  return false;
};

const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-attentioncfg-`));
writeFileSync(join(CONFIG, "plugin-paths.json"), JSON.stringify({ paths: [resolve("scripts/fixtures/plugin-attention")] }));
const h = await bootHost({ tag: "attention", quiet: true, env: { [E.CONFIG_DIR]: CONFIG } });
const dog = watchdog(async () => { console.log("FAIL: e2e-attention hung"); await h.stop(); process.exit(1); }, 90_000);
const open = [];

async function api(path, { method = "GET", headers = {}, body } = {}) {
  const r = await fetch(h.base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json };
}
const read = async () => (await api("/api/attention")).json;

try {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
  open.push(ws);
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: "hello", protocol: 1 });
  await until(() => frames.some((f) => f.t === "welcome"));

  const w0 = await read();
  check(w0?.sessions?.n === 0 && w0?.attention?.n === 0 && typeof w0?.ts === "number", `a fresh host waits on nothing (${JSON.stringify(w0)})`);

  // ── a session showing a choice box ──
  const repo = (await api("/api/repo", { method: "POST", body: { name: "waits" } })).json;
  send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 });
  check(await until(() => frames.some((f) => f.t === "session.created")), "a session starts");
  const sid = frames.find((f) => f.t === "session.created").session.id;
  send({ t: "session.attach", id: sid });
  await sleep(300);
  const BOX = "Do you want to proceed?\\n\\xe2\\x9d\\xaf 1. Yes\\n  2. No\\n\\nEsc to cancel\\n";
  send({ t: "session.input", id: sid, data: `clear; printf '${BOX}'\r` });
  check(await until(async () => (await read())?.sessions?.n === 1, 10000), "a choice box on a live session ⇒ sessions.n 1");
  check((await read())?.sessions?.ids?.[0] === sid, "…naming that session");

  // ── an urgent plugin card ──
  const ackId = "attention-ask-1";
  send({ t: "plugin.call", plugin: "asker", method: "ask", ackId });
  check(await until(() => frames.some((f) => f.t === "plugin.reply" && f.ackId === ackId)), "the fixture plugin raised its card");
  const isAsk = (i) => i.plugin === "asker";
  check(await until(async () => ((await read())?.attention?.items ?? []).some(isAsk)), "the urgent plugin card is listed");
  const w1 = await read();
  // The session's own "needs you" item is the same wait as sessions.n — counted once, never twice.
  check(w1?.attention?.n === 1 && w1?.sessions?.n === 1, `…as attention.n 1 beside sessions.n 1, the box not counted twice (${JSON.stringify(w1)})`);
  const item = w1?.attention?.items?.find(isAsk);
  check(item?.kind === "approval" && item?.plugin === "asker" && /approve a key/.test(item?.title ?? ""), `…as an approval line from that plugin (${JSON.stringify(item)})`);
  check(item && !("body" in item), "…with no body");

  // ── handled ──
  send({ t: "notification.handle", id: item?.id });
  check(await until(async () => (await read())?.attention?.n === 0), "notification.handle ⇒ attention.n 0");
  send({ t: "session.input", id: sid, data: "clear\r" });

  // ── browser checks: Origin and Host ──
  const evil = await api("/api/attention", { headers: { origin: "http://evil.example" } });
  check(evil.status === 403, `a cross-origin Origin is refused (${evil.status})`);
  // fetch may not set Host (a forbidden header), so the rebinding case goes over node:http.
  const rebound = await new Promise((res) => {
    const rq = httpRequest({ host: "127.0.0.1", port: h.port, path: "/api/attention", headers: { host: "evil.example" } }, (r) => { r.resume(); res(r.statusCode); });
    rq.on("error", () => res(0));
    rq.end();
  });
  check(rebound === 403, `a rebinding Host is refused (${rebound})`);

  // ── a passive device token ──
  const askWs = (msg, want) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + msg.t)), 5000);
    const onMsg = (raw) => { const m = JSON.parse(raw.toString()); if (want(m)) { clearTimeout(t); ws.off("message", onMsg); res(m); } };
    ws.on("message", onMsg);
    send(msg);
  });
  await askWs({ t: "auth.set", password: "e2e-attention-password" }, (m) => m.t === "auth.state" && m.auth.enabled);
  const mint = await api("/api/pair/mint", { method: "POST", body: { passive: true } });
  const redeem = await api("/api/pair/redeem", { method: "POST", body: { code: mint.json?.code, deviceName: "kids phone" } });
  const kid = redeem.json?.token;
  check(typeof kid === "string" && redeem.json?.scope === "passive", "a passive token is handed out");
  const passive = await api("/api/attention", { headers: { authorization: `Bearer ${kid}` } });
  check(passive.status === 403, `a passive token is refused the route (${passive.status})`);
} finally {
  clearTimeout(dog);
  for (const ws of open) { try { ws.close(); } catch { /* closing */ } }
  await h.stop();
}
process.exit(failed ? 1 : 0);
