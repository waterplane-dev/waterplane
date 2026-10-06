#!/usr/bin/env node
// A fake `ciqkit`, for `scripts/e2e-capture.mjs`.
//
// The garmin backend (`packages/host/src/capture/garmin.ts`) is the only one of
// the four that can be driven end to end on a build machine: `web` needs
// Playwright plus a dev server, `android` needs a device, `window` photographs
// whoever's desktop the suite happens to run on. So the capture loop is pinned
// against this — a binary that satisfies ciqkit's argv and, more importantly,
// its EXIT-CODE contract, which is the part the host reasons over:
//
//   0  captured (anchor found, or no OCR was installed at all)
//   1  the job failed
//   3  captured a frame, and OCR said the anchor text was NOT on it
//
// Exit 3 is the interesting one and the reason this file exists rather than a
// one-line `echo`: it is a DOWNGRADE, not a failure. The frame is kept as
// evidence, `anchor.missing` is recorded, and the verification level drops from
// `verified:anchor` to `settled:stable`. Nothing else in the suite can produce
// that path.
//
// Commands understood, exactly as `garmin.ts` spells them:
//   ciqkit sim --help
//   ciqkit sim shot <screen> --project <dir> --out-dir <dir> --max <s> [--force] [--device D] [--anchor TEXT]...
//   ciqkit shot-score <file|dir> --json
//
// Env knobs (the e2e script sets these on the HOST, which passes its whole
// environment down to the spawn):
//   <ENV>_CAPTURE_STUB_EXIT3   "1" ⇒ always exit 3. Any other value is treated as
//                             a PATH: exit 3 while that file exists, 0 when it
//                             does not. A path is what lets one host process
//                             produce both outcomes in one run of the script —
//                             the env of a spawned daemon cannot be changed
//                             after the fact, but a file on disk can.
//   <ENV>_CAPTURE_STUB_FAIL    same two forms, for exit 1 (the job failed).
//   <ENV>_CAPTURE_STUB_SCORE   the 0-100 `shot-score` should report, in the same
//                             two forms: a bare number, or a PATH holding one
//                             (an absent file ⇒ no scorer, so one host process
//                             can produce both outcomes). UNSET is the default:
//                             with no scorer, `shot-score` answers an empty list
//                             and the sidecar must OMIT `score` rather than
//                             write a 0 nobody measured. Note that `shot-score`
//                             still only answers about a frame that is ACTUALLY
//                             at the path it was handed — see its block.
//
// The frame is generated here rather than committed: a binary fixture in the
// repo is a file nobody can review, and the only properties the loop needs of
// it are that it is a valid PNG with a readable IHDR (so `pngSize` can answer
// the verdict's geometry), that it is NOT one flat colour (a machine with
// ImageMagick would otherwise read it as `blank` and fail the run), and that it
// is byte-identical every time (the settle check is byte-equality, so a frame
// that differed per sample could never reach `settled:stable`).
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { E } from "./lib-brand.mjs";

// ── the tiny PNG ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** A 16x16 four-pixel checkerboard: valid IHDR, real variance, ~100 bytes. */
function fixturePng(w = 16, h = 16) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const light = ((x >> 2) + (y >> 2)) % 2 === 0;
      const v = light ? 0xf2 : 0x11;
      raw[o++] = v; raw[o++] = v; raw[o++] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the switches ────────────────────────────────────────────────────────────

/** "1" ⇒ on; anything else ⇒ on while that PATH exists. Unset ⇒ off. */
function flag(name) {
  const v = process.env[name];
  if (!v) return false;
  if (v === "1") return true;
  return existsSync(isAbsolute(v) ? v : resolve(v));
}

/** The number `shot-score` should report: a bare value, or a PATH holding one.
 *  Unset — or a path with no file at it — means NO SCORER is installed here. */
function scoreSetting() {
  const v = process.env[E.CAPTURE_STUB_SCORE];
  if (!v) return null;
  const direct = Number(v);
  if (Number.isFinite(direct)) return direct;
  let raw;
  try { raw = readFileSync(isAbsolute(v) ? v : resolve(v), "utf8"); } catch { return null; }
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function allOf(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
}

// ── the commands ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv[0] === "sim" && argv.includes("--help")) {
  process.stdout.write("usage: ciqkit sim shot NAME --project DIR --out-dir DIR [--device D] [--anchor TEXT]\n");
  process.exit(0);
}

if (argv[0] === "sim" && argv[1] === "shot") {
  const screen = argv[2] || "";
  const outDir = argOf(argv, "--out-dir");
  const project = argOf(argv, "--project");
  const anchors = allOf(argv, "--anchor");
  if (!screen || !outDir || !project) {
    process.stderr.write("stub: sim shot needs a screen, --project and --out-dir\n");
    process.exit(1);
  }
  if (flag(E.CAPTURE_STUB_FAIL)) {
    // Exit 1 writes NOTHING: a job that failed produced no frame.
    process.stderr.write(`stub: the simulator never came up for "${screen}"\n`);
    process.exit(1);
  }

  const png = join(outDir, `${screen}.png`);
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png, fixturePng());

  const contradicted = flag(E.CAPTURE_STUB_EXIT3);
  // ciqkit's own job JSON, down to the one field the host reads back out of it.
  // `anchor: null` would mean "OCR is not installed", which is a THIRD state and
  // not what either of these two runs is about.
  process.stdout.write(JSON.stringify({
    job: {
      results: [
        { kind: "build", result: { ok: true } },
        { kind: "shot", result: { path: png, anchor: contradicted ? false : (anchors.length ? true : null) } },
      ],
    },
  }) + "\n");
  if (contradicted) {
    process.stderr.write(`stub: captured "${screen}", but the anchor text was not on the frame\n`);
    process.exit(3);
  }
  process.exit(0);
}

if (argv[0] === "shot-score") {
  // The PATH is a file or a directory, as real ciqkit takes it — and either way
  // this answers only about what is ACTUALLY THERE. That is the load-bearing
  // part of this block rather than a detail: `shot-score` can only report on a
  // frame that still exists where the caller says it does, so asking it about a
  // directory the frame has just been renamed out of, or about a scratch path a
  // run has already deleted, yields nothing — for ever, on every run, and
  // SILENTLY, because absent is also exactly what "no scorer installed" looks
  // like. Answering from `<ENV>_CAPTURE_STUB_SCORE` alone (as this once did)
  // makes that class of bug untestable: the stub would hand back a number
  // whatever the caller had already done with the file. So the env says WHAT the
  // score is; the path on disk says WHETHER there is anything to score.
  const target = argv[1] || ".";
  let frames = [];
  try {
    frames = statSync(target).isDirectory()
      ? readdirSync(target).filter((f) => f.endsWith(".png")).sort().map((f) => join(target, f))
      : [target];
  } catch { frames = []; }
  if (!frames.length) {
    // Nothing there. Real ciqkit prints `json.dumps([])` — an empty list, not an
    // error message — and exits 2.
    process.stdout.write("[]\n");
    process.exit(2);
  }
  const score = scoreSetting();
  // Frames present but no scorer configured is the OTHER empty list: nobody
  // measured, rather than nothing was there. Never `[{score: 0}]` — the host
  // must leave `score` absent, because a zero here would be a number nobody
  // measured, which is the one thing this repo's heuristics may not do.
  if (score === null) { process.stdout.write("[]\n"); process.exit(0); }
  process.stdout.write(JSON.stringify(frames.map((path) => ({ path, score }))) + "\n");
  process.exit(0);
}

process.stderr.write(`stub: unknown ciqkit command ${JSON.stringify(argv.join(" "))}\n`);
process.exit(1);
