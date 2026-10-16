// Plugin streams end to end (docs/notes/plugins.md, "Streams"; plugin API 1.4): a real host
// loads the fixture plugin (scripts/fixtures/plugin-stream) from a temp config dir's
// plugin-paths.json, and a real `ws` client opens its stream "ticker" on the ONE socket.
// Pinned: opened; binary frames that decode with the shared header, seq increasing; a params
// re-steer reaching the plugin (and its frames); one input reaching it exactly once; a refusal
// in the plugin's own sentence; close stopping the frames; a killed socket ending the sub with
// cause "socket"; and a second socket that never opened a stream receiving ZERO binary frames
// (an old APK bundle must never see one).
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { decodeStreamFrame, STREAM_FLAG_KEY } from "../packages/shared/dist/index.js";

const PORT = 8957;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-stream-`));
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-streamcfg-`));
writeFileSync(join(CONFIG, "plugin-paths.json"), JSON.stringify({ paths: [resolve("scripts/fixtures/plugin-stream")] }));

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG,
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let hostLog = "";
host.stdout.on("data", (d) => { hostLog += d; });
host.stderr.on("data", (d) => { hostLog += d; process.stderr.write("[host] " + d); });
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(50); }
  return false;
};

/** One client socket: JSON by `t`, binary frames decoded, nothing else. */
async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, json: [], frames: [], binary: 0, replies: new Map() };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) { c.binary++; const f = decodeStreamFrame(new Uint8Array(raw)); if (f) c.frames.push({ ...f, body: JSON.parse(Buffer.from(f.payload).toString("utf8")) }); return; }
    const m = JSON.parse(raw.toString());
    c.json.push(m);
    if (m.t === "plugin.reply") c.replies.set(m.ackId, m);
  });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.find = (pred) => c.json.find(pred);
  c.send({ t: "hello", protocol: 2 });
  return c;
}

let ack = 0;
async function pluginLog(c) {
  const ackId = `log-${++ack}-${Date.now().toString(36)}`;
  c.send({ t: "plugin.call", plugin: "streamer", method: "log", ackId });
  await until(() => c.replies.has(ackId), 3000);
  return c.replies.get(ackId)?.result ?? null;
}

bootWait(PORT, 300, async () => {
  try {
    const a = await client();
    const old = await client(); // never opens a stream: an old bundle
    await until(() => a.json.some((m) => m.t === "plugin.list" && m.plugins.some((p) => p.manifest.id === "streamer" && p.state === "active")), 8000);
    check(a.json.some((m) => m.t === "plugin.list" && m.plugins.some((p) => p.manifest.id === "streamer" && p.state === "active")), "the fixture plugin is active");

    // ── open ──
    a.send({ t: "stream.open", reqId: "r1", plugin: "streamer", name: "ticker", params: { label: "one" } });
    await until(() => a.find((m) => m.reqId === "r1"));
    const op = a.find((m) => m.reqId === "r1");
    check(op?.t === "stream.opened" && op.streamId >= 1 && op.plugin === "streamer" && op.name === "ticker", `stream.opened with a streamId (got ${JSON.stringify(op)})`);
    const id = op?.streamId;

    // ── frames ──
    await until(() => a.frames.filter((f) => f.streamId === id).length >= 6);
    const mine = a.frames.filter((f) => f.streamId === id);
    check(mine.length >= 6, `binary frames arrive and decode with the shared header (got ${mine.length})`);
    check(mine.every((f, i) => i === 0 || f.seq === mine[i - 1].seq + 1), `seq increases by one per frame (got ${mine.map((f) => f.seq).join(",")})`);
    check((mine[0]?.flags & STREAM_FLAG_KEY) !== 0 && mine[0]?.body?.n === 0, "the first frame is the plugin's key frame");
    check(mine.every((f) => f.body.label === "one"), "the frames carry the params they were opened with");
    a.send({ t: "stream.ack", streamId: id, seq: mine.at(-1).seq, rxBytes: mine.reduce((s, f) => s + f.payload.byteLength, 0) });

    // ── params re-steer ──
    a.send({ t: "stream.params", streamId: id, params: { label: "two" } });
    await until(() => a.frames.some((f) => f.streamId === id && f.body.label === "two"));
    check(a.frames.some((f) => f.streamId === id && f.body.label === "two"), "a params re-steer reaches the plugin and its next frames");

    // ── input, once ──
    a.send({ t: "stream.input", streamId: id, ev: { type: "tap", x: 0.5, y: 0.25 } });
    a.send({ t: "stream.input", streamId: 999, ev: { type: "stale" } }); // an unknown id is ignored
    await sleep(200);
    let log = await pluginLog(a);
    check(JSON.stringify(log?.inputs) === JSON.stringify([{ type: "tap", x: 0.5, y: 0.25 }]), `the input reached the plugin exactly once (got ${JSON.stringify(log?.inputs)})`);
    check(JSON.stringify(log?.params) === JSON.stringify([{ label: "two" }]), `the params reached it once (got ${JSON.stringify(log?.params)})`);

    // ── refusals in words ──
    a.send({ t: "stream.open", reqId: "r2", plugin: "streamer", name: "ticker", params: { refuse: true } });
    a.send({ t: "stream.open", reqId: "r3", plugin: "streamer", name: "radio" });
    a.send({ t: "stream.open", reqId: "r4", plugin: "nobody", name: "ticker" });
    await until(() => ["r2", "r3", "r4"].every((r) => a.find((m) => m.reqId === r)));
    const r2 = a.find((m) => m.reqId === "r2"), r3 = a.find((m) => m.reqId === "r3"), r4 = a.find((m) => m.reqId === "r4");
    check(r2?.t === "stream.refused" && r2.reason === "The ticker is resting today", `a refused open says the plugin's sentence (got ${JSON.stringify(r2)})`);
    check(r3?.t === "stream.refused" && /Streamer serves no stream "radio"/.test(r3.reason), `an unknown name is refused in words (got ${r3?.reason})`);
    check(r4?.t === "stream.refused" && /no plugin "nobody" is installed/.test(r4.reason), `an unknown plugin is refused in words (got ${r4?.reason})`);

    // ── close stops the frames ──
    a.send({ t: "stream.close", streamId: id });
    await sleep(250);
    const atClose = a.frames.filter((f) => f.streamId === id).length;
    await sleep(400);
    check(a.frames.filter((f) => f.streamId === id).length === atClose, `no frame after close (${atClose} then ${a.frames.filter((f) => f.streamId === id).length})`);
    log = await pluginLog(a);
    check(JSON.stringify(log?.closes) === JSON.stringify(["closed"]), `the plugin heard close "closed" (got ${JSON.stringify(log?.closes)})`);
    a.send({ t: "stream.close", streamId: id }); // a stale close is ignored in silence
    await sleep(100);
    check(!a.json.some((m) => m.t === "error"), "a stale close is no error");

    // ── a killed socket ends its sub, cause "socket" ──
    const b = await client();
    b.send({ t: "stream.open", reqId: "b1", plugin: "streamer", name: "ticker" });
    await until(() => b.frames.length >= 2);
    check(b.find((m) => m.reqId === "b1")?.t === "stream.opened" && b.frames.length >= 2, "a second socket opens its own stream");
    check(a.frames.length === a.frames.filter((f) => f.streamId === id).length && atClose === a.frames.length, "…and its frames go to it alone");
    b.ws.terminate();
    await sleep(300);
    log = await pluginLog(a);
    check(JSON.stringify(log?.closes) === JSON.stringify(["closed", "socket"]), `a killed socket ends the sub with cause "socket" (got ${JSON.stringify(log?.closes)})`);

    // ── the socket that never asked saw no binary at all ──
    check(old.binary === 0, `a socket that never opened a stream received zero binary frames (got ${old.binary})`);
    check(old.json.some((m) => m.t === "welcome"), "…while its text path worked as before");

    // ── one host log line per open and close ──
    check(/stream open plugin=streamer name=ticker id=\d+/.test(hostLog) && /stream close plugin=streamer name=ticker id=\d+ cause=closed/.test(hostLog) && /cause=socket/.test(hostLog),
      "the host logs each open and close with plugin, name, id and cause");

    a.ws.close(); old.ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill("SIGTERM");
    for (const d of [ROOT, CONFIG]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    console.log(failed ? "\nE2E STREAM: FAIL" : "\nE2E STREAM: PASS");
    process.exit(failed ? 1 : 0);
  }
});
