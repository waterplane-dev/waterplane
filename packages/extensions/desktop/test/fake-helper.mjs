#!/usr/bin/env node
// A fake `wp-desktop serve` for the host tests (helper/PROTOCOL.md's stdin/stdout, nothing else):
// JSON lines in, length-prefixed records out. It touches no screen and posts nothing — it only
// writes down what it was told, one JSON line per stdin command, to $FAKE_LOG.
//
//   FAKE_MODE=normal  frames every 30 ms once configured (a key first, then P-frames; JPEG = keys)
//   FAKE_MODE=die     exits 7 after 300 ms, on its own
//   FAKE_MODE=stubborn  ignores stop, EOF and SIGTERM (only SIGKILL ends it)
//   FAKE_AX=1         reports Accessibility as granted
//   FAKE_LAG=1        after a crop change, one more key OF THE OLD REGION comes out before the new
//                     region starts (a key the core asked for itself, or a keyframeEverySec key, that
//                     was already in the encoder when the config landed)
//
// Regions (PROTOCOL.md): a status naming the new region is written immediately before its first
// frame, and every frame's payload is filled with its region's `regionSeq`, so a test can tell which
// region a frame belongs to without decoding anything.
import { appendFileSync } from "node:fs";

const MODE = process.env.FAKE_MODE || "normal";
const LOG = process.env.FAKE_LOG;
const AX = process.env.FAKE_AX === "1";
const note = (o) => { if (LOG) appendFileSync(LOG, JSON.stringify(o) + "\n"); };
note({ start: process.pid, argv: process.argv.slice(2) });

// `request [screen|accessibility]`: the real one raises a macOS dialog; this one only answers.
//   FAKE_REQUEST=fail  exits 1 with a stderr line, as a helper that could not run would
if (process.argv[2] === "request") {
  if (process.env.FAKE_REQUEST === "fail") { process.stderr.write("wp-desktop: request: boom\n"); process.exit(1); }
  const kinds = process.argv[3] && !process.argv[3].startsWith("-") ? [process.argv[3]] : ["screen", "accessibility"];
  console.log(JSON.stringify({ dry: false, responsibleSelf: true, ...Object.fromEntries(kinds.map((k) => [k, { already: false, granted: false, asked: true }])) }));
  process.exit(0);
}

function record(kind, key, payload) {
  const out = Buffer.alloc(14 + payload.length);
  out.writeUInt32LE(10 + payload.length, 0);
  out[4] = kind; out[5] = key ? 1 : 0;
  out.writeBigUInt64LE(process.hrtime.bigint() / 1000n, 6);
  payload.copy(out, 14);
  // Split each record across two writes, so the host's reader sees headers cut in half.
  process.stdout.write(out.subarray(0, 3));
  process.stdout.write(out.subarray(3));
}
const json = (o) => record(4, false, Buffer.from(JSON.stringify(o)));

let cfg = null, timer = null, n = 0, wantKey = true;
const LAG = process.env.FAKE_LAG === "1";
const sameCrop = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
let out = { seq: 0, crop: null }; // the region of the frames being written
let want = { seq: 0, crop: null }; // the region the newest config asks for
function status(state, extra = {}) {
  const w = cfg?.maxWidth || 2560;
  json({ t: "status", state, width: w, height: Math.round(w * 0.625), srcWidth: 2560, srcHeight: 1600, fps: cfg?.fps ?? 15,
    codec: cfg?.codec ?? "h264", bitrateKbps: cfg?.bitrateKbps ?? 1000, source: "display", screenRecording: true,
    accessibility: AX, responsibleSelf: true, helperVersion: "fake",
    ...(out.seq > 0 ? { crop: out.crop ?? { x: 0, y: 0, w: 1, h: 1 }, regionSeq: out.seq } : {}), ...extra });
}
function startFrames() {
  if (timer) return;
  timer = setInterval(() => {
    const jpeg = cfg?.codec === "jpeg";
    let key = jpeg || wantKey || n % 50 === 0;
    if (out.seq !== want.seq) {
      if (LAG && out.seq > 0 && !lagged) { lagged = true; key = true; } // one more key of the old region
      else { out = want; status("running"); key = true; lagged = false; } // announce, then the first frame
    }
    wantKey = false;
    record(jpeg ? 2 : 1, key, Buffer.alloc(key ? 3000 : 600, out.seq));
    n++;
    if (n % 20 === 0) json({ t: "stats", fps: 33.3, kbps: 200, keys: 1, captured: 20, dropped: 0, periodMs: 600, idle: false });
  }, 30);
}

let lagged = false;
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { process.stderr.write(`wp-desktop: bad line\n`); continue; }
    note(m);
    if (m.t === "config") {
      if (want.seq === 0 || !sameCrop(want.crop, m.crop)) want = { seq: want.seq + 1, crop: m.crop ?? null };
      cfg = m; wantKey = true; status("running"); startFrames();
    }
    else if (m.t === "keyframe") wantKey = true;
    else if (m.t === "bitrate") { if (cfg) cfg.bitrateKbps = m.kbps; status("running"); }
    else if (m.t === "input") process.stderr.write(`wp-desktop: dry-input: ${m.ev.k}\n`);
    else if (m.t === "stop" && MODE !== "stubborn") { clearInterval(timer); timer = null; status("stopped"); }
  }
});
process.stdin.on("end", () => { if (MODE !== "stubborn") process.exit(0); });
if (MODE === "stubborn") { process.on("SIGTERM", () => note({ ignored: "SIGTERM" })); setInterval(() => {}, 1000); }
if (MODE === "die") setTimeout(() => process.exit(7), 300);
