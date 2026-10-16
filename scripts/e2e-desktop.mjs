// The live desktop end to end (packages/extensions/desktop; plan docs/analysis/desktop-stream-plan.md):
// a real host on a temp root and state dir, with WATERPLANE_DESKTOP_SYNTHETIC=1, so every helper runs
// `--source synthetic --no-capture --dry-input`: the test pattern, never the screen, and input is
// logged instead of posted. The host BUILDS the real wp-desktop into the temp state dir on the first
// probe, and a real `ws` client streams it on the one socket.
// Pinned: the probe builds the helper and answers; frames arrive and the first is an H.264 key that
// decodes (ffprobe when present, else a structural SPS/PPS/IDR check); a params change shrinks the
// picture (a new key, a status with the new width); a crop change brings a key; input is dropped
// with control off and reaches the helper (as a dry-input line) once control is on; Auto reports its
// pick; close stops the helper process. Prints kbit/s and fps measured over the real helper.
// SKIPs (exit 0, saying why) when this is not a Mac or there is no swiftc.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { decodeStreamFrame, STREAM_FLAG_DROPPABLE, STREAM_FLAG_KEY } from "../packages/shared/dist/index.js";

if (process.platform !== "darwin") { console.log("SKIP: e2e-desktop needs macOS (the helper is Swift on ScreenCaptureKit)"); process.exit(0); }
if (spawnSync("xcrun", ["--sdk", "macosx", "--find", "swiftc"], { stdio: "ignore" }).status !== 0) {
  console.log("SKIP: e2e-desktop needs swiftc (xcode-select --install)"); process.exit(0);
}

const PORT = 8963;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-desktop-`));
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-desktopcfg-`));
const STATE = rootEnv(ROOT)[E.STATE_DIR];
const SCRATCH = mkdtempSync(join(tmpdir(), `${SLUG}-desktoph264-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG,
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.DESKTOP_SYNTHETIC]: "1",
};
delete env[E.DESKTOP_HELPER];
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let hostLog = "";
host.stdout.on("data", (d) => { hostLog += d; });
host.stderr.on("data", (d) => { hostLog += d; process.stderr.write("[host] " + d); });
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(50); } return !!cond(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hasFfprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, json: [], frames: [], replies: new Map() };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) { const f = decodeStreamFrame(new Uint8Array(raw)); if (f) c.frames.push({ ...f, payload: Buffer.from(f.payload), at: Date.now() }); return; }
    const m = JSON.parse(raw.toString());
    c.json.push(m);
    if (m.t === "plugin.reply") c.replies.set(m.ackId, m);
  });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.send({ t: "hello", protocol: 2 });
  return c;
}

let ack = 0;
async function call(c, method) {
  const ackId = `d-${++ack}-${Date.now().toString(36)}`;
  c.send({ t: "plugin.call", plugin: "desktop", method, ackId });
  await until(() => c.replies.has(ackId), 15000);
  return c.replies.get(ackId) ?? null;
}

/** The H.264 NAL unit types in an Annex-B access unit. */
function nalTypes(buf) {
  const out = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const at = buf[i + 2] === 1 ? i + 3 : i + 4;
      if (at < buf.length) out.push(buf[at] & 0x1f);
      i = at;
    }
  }
  return out;
}

/** Decode a run of access units (from a key on) to its width and frame count, or a structural check. */
function decode(units, label) {
  const file = join(SCRATCH, `${label}.h264`);
  writeFileSync(file, Buffer.concat(units));
  if (!hasFfprobe) {
    const t = nalTypes(units[0]);
    return { ok: t.includes(7) && t.includes(8) && t.includes(5), how: `structural NAL check (${t.join(",")})` };
  }
  try {
    const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", file], { encoding: "utf8" }));
    const s = out.streams?.[0] ?? {};
    return { ok: s.codec_name === "h264" && Number(s.nb_read_frames) >= 1, width: s.width, height: s.height, frames: Number(s.nb_read_frames), how: "ffprobe" };
  } catch (e) {
    return { ok: false, how: `ffprobe failed: ${e.message.split("\n")[0]}` };
  }
}

bootWait(PORT, 300, async () => {
  let ackTimer;
  try {
    const a = await client();
    await until(() => a.json.some((m) => m.t === "plugin.list" && m.plugins.some((p) => p.manifest.id === "desktop" && p.state === "active")), 8000);
    check(a.json.some((m) => m.t === "plugin.list" && m.plugins.some((p) => p.manifest.id === "desktop" && p.state === "active")), "the desktop extension is active");

    // ── the probe builds the helper, then answers ──
    const t0 = Date.now();
    let probe = await call(a, "probe");
    check(probe?.ok && probe.result.available === false && /being built/.test(probe.result.reason ?? ""), `the first probe starts the build and says so (got ${JSON.stringify(probe?.result ?? probe)})`);
    while (Date.now() - t0 < 180_000 && !(probe?.ok && probe.result.available)) { await sleep(1000); probe = await call(a, "probe"); }
    const buildS = ((Date.now() - t0) / 1000).toFixed(1);
    check(probe?.ok && probe.result.available === true && probe.result.displays.length >= 1, `the probe answers once wp-desktop is built (${buildS} s; got ${JSON.stringify(probe?.result ?? probe)})`);
    check(existsSync(join(STATE, "bin", "wp-desktop")) && existsSync(join(STATE, "bin", "wp-desktop.srchash")), "built into <state dir>/bin/wp-desktop with its .srchash");
    check(probe?.result?.screenRecording === false, "synthetic mode probes with --no-capture: Screen Recording reads as not granted");
    check(probe?.result?.controlEnabled === false, "control starts off");

    // ── open: Balanced, fixed ──
    const P = { codec: "h264", source: { kind: "display" }, maxWidth: 1280, fps: 15, bitrateKbps: 800, auto: false, cursor: true };
    a.send({ t: "stream.open", reqId: "o1", plugin: "desktop", name: "screen", params: P });
    await until(() => a.json.some((m) => m.reqId === "o1"), 15000);
    const op = a.json.find((m) => m.reqId === "o1");
    check(op?.t === "stream.opened", `stream.opened (got ${JSON.stringify(op)})`);
    const id = op?.streamId;
    const pid = Number(/stream open id=\S+ .* pid=(\d+)/.exec(hostLog)?.[1]);
    check(pid > 0 && alive(pid), `one log line for the open, naming the helper pid (${pid})`);
    check(/stream open id=\S+ codec=h264 source=display maxWidth=1280 fps=15 800kbps control=off \(synthetic, dry input\)/.test(hostLog), "…and its params");
    const mine = () => a.frames.filter((f) => f.streamId === id);
    let rx = 0, lastSeq = 0;
    ackTimer = setInterval(() => {
      const fs = mine();
      if (!fs.length) return;
      rx = fs.reduce((s, f) => s + f.payload.length, 0); lastSeq = fs.at(-1).seq;
      a.send({ t: "stream.ack", streamId: id, seq: lastSeq, rxBytes: rx });
    }, 250);

    await until(() => mine().length >= 20, 10000);
    const first = mine()[0];
    check(first && (first.flags & STREAM_FLAG_KEY) && !(first.flags & STREAM_FLAG_DROPPABLE) && first.kind === 1, `the first frame is an H.264 key, not droppable (flags ${first?.flags}, kind ${first?.kind})`);
    check(mine().slice(1).some((f) => (f.flags & STREAM_FLAG_DROPPABLE) && !(f.flags & STREAM_FLAG_KEY)), "P-frames are droppable");
    const dec = decode(mine().map((f) => f.payload), "balanced");
    check(dec.ok && (dec.width === undefined || dec.width === 1280), `the stream decodes from its first key (${dec.how}${dec.width ? `, ${dec.width}×${dec.height}, ${dec.frames} frames` : ""})`);
    const st0 = a.json.filter((m) => m.t === "stream.status" && m.streamId === id).at(-1)?.data;
    check(st0?.state === "running" && st0.width === 1280 && st0.codec === "h264" && st0.bitrateKbps === 800, `status: running 1280 wide at 800 kbit/s (got ${JSON.stringify(st0)})`);
    check(st0?.control?.on === false && /Control is off/.test(st0.control.reason ?? ""), "status: control off, in words");

    // measured over 4 s
    const m0 = mine().length, b0 = mine().reduce((s, f) => s + f.payload.length, 0), tm0 = Date.now();
    await sleep(4000);
    const secs = (Date.now() - tm0) / 1000;
    const fpsB = (mine().length - m0) / secs, kbpsB = ((mine().reduce((s, f) => s + f.payload.length, 0) - b0) * 8) / 1000 / secs;
    console.log(`  balanced (1280 wide, 15 fps cap, 800 kbit/s): ${fpsB.toFixed(1)} fps, ${kbpsB.toFixed(0)} kbit/s over the socket`);
    check(fpsB > 5 && kbpsB > 20 && kbpsB < 1600, `frames keep coming at a sane rate (${fpsB.toFixed(1)} fps, ${kbpsB.toFixed(0)} kbit/s)`);

    // ── input: dropped with control off, a dry-input line once on ──
    a.send({ t: "stream.input", streamId: id, ev: { k: "click", b: "l", x: 0.5, y: 0.5, n: 1 } });
    await sleep(400);
    check(!/dry-input:/.test(hostLog), "control off: the click never reached the helper");
    check(/input dropped: control is off/.test(hostLog), "…and the host said so once");
    a.send({ t: "plugin.set", id: "desktop", values: { control: true } });
    await until(() => /control enabled/.test(hostLog), 5000);
    check(/control enabled/.test(hostLog), "turning control on is logged");
    a.send({ t: "stream.input", streamId: id, ev: { k: "click", b: "l", x: 0.5, y: 0.5, n: 1 } });
    await until(() => /dry-input: leftMouseDown/.test(hostLog), 5000);
    check(/dry-input: leftMouseDown/.test(hostLog) && /dry-input: leftMouseUp/.test(hostLog), "control on: the click reaches the helper (dry run: built, logged, not posted)");
    const ctl = a.json.filter((m) => m.t === "stream.status" && m.streamId === id).at(-1)?.data?.control;
    check(ctl && (ctl.on ? !ctl.reason : /Accessibility/.test(ctl.reason ?? "") && !/Control is off/.test(ctl.reason ?? "")), `status follows the setting: on, or only Accessibility missing (control ${JSON.stringify(ctl)})`);
    a.send({ t: "plugin.set", id: "desktop", values: { control: false } });

    // ── params: smaller picture, new key, status says so ──
    const before = mine().length;
    a.send({ t: "stream.params", streamId: id, params: { ...P, maxWidth: 640 } });
    await until(() => a.json.some((m) => m.t === "stream.status" && m.streamId === id && m.data?.width === 640), 6000);
    await until(() => mine().slice(before).some((f) => f.flags & STREAM_FLAG_KEY) && mine().length > before + 10, 6000);
    const after = mine().slice(before);
    const k = after.findIndex((f) => f.flags & STREAM_FLAG_KEY);
    const dec2 = k >= 0 ? decode(after.slice(k).map((f) => f.payload), "small") : { ok: false, how: "no key after the change" };
    check(a.json.some((m) => m.t === "stream.status" && m.streamId === id && m.data?.width === 640), "status names the new width");
    check(dec2.ok && (dec2.width === undefined || dec2.width === 640), `after a params change the picture shrinks, starting on a key (${dec2.how}${dec2.width ? `, ${dec2.width}×${dec2.height}` : ""})`);

    // ── crop: a key of the new region ──
    const beforeCrop = mine().length;
    a.send({ t: "stream.params", streamId: id, params: { ...P, maxWidth: 640, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } } });
    check(await until(() => mine().slice(beforeCrop).some((f) => f.flags & STREAM_FLAG_KEY), 4000), "a crop change brings a key");

    // ── Auto ──
    a.send({ t: "stream.params", streamId: id, params: { ...P, maxWidth: 1280, auto: true, bitrateKbps: 4000, fps: 30 } });
    const m1 = mine().length, b1 = mine().reduce((s, f) => s + f.payload.length, 0), tm1 = Date.now();
    await sleep(7000);
    const secsA = (Date.now() - tm1) / 1000;
    const fpsA = (mine().length - m1) / secsA, kbpsA = ((mine().reduce((s, f) => s + f.payload.length, 0) - b1) * 8) / 1000 / secsA;
    const autoSt = a.json.filter((m) => m.t === "stream.status" && m.streamId === id).at(-1)?.data;
    console.log(`  auto (1280 wide, 30 fps cap, ≤4000 kbit/s): ${fpsA.toFixed(1)} fps, ${kbpsA.toFixed(0)} kbit/s over the socket; Auto's pick ${autoSt?.bitrateKbps} kbit/s`);
    check(typeof autoSt?.bitrateKbps === "number" && autoSt.bitrateKbps >= 1000 && autoSt.bitrateKbps <= 4000, `Auto reports its pick under the cap on a clean link (${autoSt?.bitrateKbps})`);

    // ── close stops the helper ──
    clearInterval(ackTimer);
    a.send({ t: "stream.close", streamId: id });
    check(await until(() => !alive(pid), 5000), "close stops the helper process");
    check(/stream close id=\S+ cause=closed after/.test(hostLog), "one log line for the close");
    const atClose = mine().length;
    await sleep(300);
    check(mine().length === atClose, "no frame after close");
    a.ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    clearInterval(ackTimer);
    host.kill("SIGTERM");
    // The host flushes its state on SIGTERM: wait for it, so the temp root is not written after it is removed.
    if (host.exitCode === null && host.signalCode === null) await Promise.race([new Promise((r) => host.once("exit", r)), sleep(5000)]);
    for (const d of [ROOT, CONFIG, SCRATCH]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    console.log(failed ? "\nE2E DESKTOP: FAIL" : "\nE2E DESKTOP: PASS");
    process.exit(failed ? 1 : 0);
  }
});
