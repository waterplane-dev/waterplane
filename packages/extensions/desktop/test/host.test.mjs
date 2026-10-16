/**
 * The live desktop's host half, without a screen: the helper's stdout reader, the Auto controller,
 * the status and control gate, the helper build cache, the setup rows, and a stream's lifecycle
 * over a FAKE helper (`fake-helper.mjs`, PROTOCOL.md's stdin/stdout and nothing else). Nothing here
 * runs the real wp-desktop: the e2e (`scripts/e2e-desktop.mjs`) does that, synthetic only.
 *
 *     node --test packages/extensions/desktop/test/host.test.mjs   (after the host build)
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const D = "../../../host/dist/extensions/desktop";
const R = await import(`${D}/host/records.mjs`);
const A = await import(`${D}/host/auto.mjs`);
const S = await import(`${D}/host/status.mjs`);
const K = await import(`${D}/host/knobs.mjs`);
const { HelperBin, helperIdentity } = await import(`${D}/host/helperbin.mjs`);
const { Prober } = await import(`${D}/host/probe.mjs`);
const { desktopRows, desktopFixes, MACOS_IS_ASKING, WINDOWS_ASKS_NOTHING, FIX_BUILD, FIX_SCREEN, FIX_ACCESSIBILITY } = await import(`${D}/host/setup.mjs`);
const { helperScroll } = await import(`${D}/host/session.mjs`);
const { createDesktop, summary } = await import(`${D}/host/desktop.mjs`);
const W = await import(`${D}/shared/wire.mjs`);

const FAKE = fileURLToPath(new URL("./fake-helper.mjs", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "wp-desktop-host-"));
const opened = new Set();
after(() => {
  for (const pid of opened) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(WORK, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); } return cond(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── records ────────────────────────────────────────────────────────────────

test("records: whole, byte by byte, split headers, many per chunk", () => {
  const recs = [R.encodeRecord(1, true, 5n, Buffer.from("key")), R.encodeRecord(1, false, 6n, Buffer.alloc(70000, 7)), R.encodeRecord(4, false, 7n, Buffer.from('{"t":"status"}'))];
  const all = Buffer.concat(recs);
  const whole = new R.RecordReader().push(all);
  assert.deepEqual(whole.map((r) => [r.kind, r.key, r.ptsMicros, r.payload.byteLength]), [[1, true, 5n, 3], [1, false, 6n, 70000], [4, false, 7n, 14]]);
  const rd = new R.RecordReader();
  const bytewise = [];
  for (let i = 0; i < all.length; i += 1 + (i % 3)) bytewise.push(...rd.push(all.subarray(i, Math.min(all.length, i + 1 + (i % 3)))));
  assert.deepEqual(bytewise.map((r) => [r.kind, r.ptsMicros, r.payload.byteLength]), [[1, 5n, 3], [1, 6n, 70000], [4, 7n, 14]]);
  assert.equal(rd.pending, 0);
  assert.equal(R.jsonRecord(bytewise[2].payload).t, "status");
  assert.equal(bytewise[1].payload.every((b) => b === 7), true);
});

test("records: garbage stops the reader in words, never a throw", () => {
  const short = new R.RecordReader();
  assert.deepEqual(short.push(Buffer.from([3, 0, 0, 0, 1, 2, 3])), []);
  assert.match(short.broken, /too short/);
  assert.deepEqual(short.push(R.encodeRecord(1, true, 1n, Buffer.from("x"))), [], "a broken reader stays broken");
  const long = new R.RecordReader();
  long.push(Buffer.from("garbage text, not a record at all"));
  assert.match(long.broken, /too long/);
  assert.equal(R.jsonRecord(Buffer.from("not json")), null);
  assert.equal(R.jsonRecord(Buffer.from("[1,2]")), null);
});

// ── Auto ───────────────────────────────────────────────────────────────────

test("auto: congestion cuts ×0.7, at most once a second, never under 100", () => {
  const a = new A.AutoController(4000, 30, 0);
  assert.equal(a.kbps, 1000);
  // 1000 kbit/s ⇒ 0.5 s is 62 500 bytes; 80 000 in flight is over the line — congested once it persists.
  assert.equal(a.tick({ sent: 100_000, rx: 20_000, skips: 0, now: 500 }), null, "over on one tick: not proof yet");
  assert.equal(a.tick({ sent: 100_000, rx: 20_000, skips: 0, now: 1000 }), null, "over for 500 ms: still not");
  assert.deepEqual(a.tick({ sent: 100_000, rx: 20_000, skips: 0, now: 500 + A.AUTO_PERSIST_MS }), { kbps: 700, fps: 30, fpsChanged: false, why: "congested" });
  assert.equal(a.tick({ sent: 200_000, rx: 20_000, skips: 0, now: 1500 }), null, "rate-limited");
  const c = a.tick({ sent: 200_000, rx: 20_000, skips: 0, now: 2250 });
  assert.equal(c.kbps, 490, "still over: the next cut a second later");
  const d = a.tick({ sent: 300_000, rx: 20_000, skips: 0, now: 3250 });
  assert.deepEqual([d.kbps, d.fps, d.fpsChanged], [343, 15, true], "under 400 kbit/s the frame rate halves, and that is a config");
  for (let t = 4000; t < 20000; t += 1000) a.tick({ sent: 1e7, rx: 0, skips: 0, now: t });
  assert.equal(a.kbps, 100, "floor");
  assert.equal(A.autoFps(100, 30), 15);
  assert.equal(A.autoFps(100, 8), 5, "half of 8 is under 5: five");
  assert.equal(A.autoFps(100, 3), 3, "never above the cap");
});

test("auto: a keyframe in flight is not congestion — re-aims on a fine link never cut the bitrate", () => {
  // 1000 kbit/s ⇒ the line is 62 500 bytes. A steady stream shows ~0.3 s in flight (rx lags one ack
  // interval); a 40 KB IDR on top tips ONE tick over, and the next ack has it. Ticks on every ack.
  const a = new A.AutoController(1000, 30, 0);
  const BPS = 125_000; // bytes a second at 1000 kbit/s
  let sent = 0, cuts = 0;
  for (let now = 250; now <= 20_000; now += 250) {
    sent += BPS / 4;
    const reAim = now % 1000 === 0; // a pinch-settle crop every second, each asking for a key
    if (reAim) sent += 40_000;
    const inFlight = 0.3 * BPS + (reAim ? 40_000 : 0); // the IDR is acked by the next tick
    const ch = a.tick({ sent, rx: sent - inFlight, skips: 0, now });
    if (ch?.why === "congested") cuts++;
  }
  assert.equal(cuts, 0, "no cut on a link that carries every byte");
  // The same over-line reading that PERSISTS is a slow link.
  const b = new A.AutoController(1000, 30, 0);
  assert.equal(b.tick({ sent: 200_000, rx: 100_000, skips: 0, now: 1000 }), null);
  assert.equal(b.tick({ sent: 230_000, rx: 120_000, skips: 0, now: 1250 }), null);
  assert.equal(b.tick({ sent: 260_000, rx: 140_000, skips: 0, now: 1500 }), null);
  assert.equal(b.tick({ sent: 290_000, rx: 160_000, skips: 0, now: 1750 }).why, "congested", "over on every tick for 750 ms");
  // A tick under the line breaks the run: it starts again.
  const c = new A.AutoController(1000, 30, 0);
  c.tick({ sent: 200_000, rx: 100_000, skips: 0, now: 1000 });
  c.tick({ sent: 200_000, rx: 190_000, skips: 0, now: 1250 });
  assert.equal(c.tick({ sent: 300_000, rx: 200_000, skips: 0, now: 1750 }), null, "the run restarted at 1750");
});

test("auto: a skipped frame is congestion, and a deferred one is not forgotten", () => {
  const a = new A.AutoController(4000, 30, 0);
  assert.equal(a.tick({ sent: 1000, rx: 1000, skips: 1, now: 500 }), null);
  assert.equal(a.tick({ sent: 1000, rx: 1000, skips: 1, now: 1100 }).kbps, 700, "the skip from before the gap still counts");
  assert.equal(a.tick({ sent: 1000, rx: 1000, skips: 1, now: 2200 }), null, "the same skip counts once");
});

test("auto: 5 s clean while sending climbs ×1.15 up to the cap; a still screen proves nothing", () => {
  const a = new A.AutoController(1200, 30, 0);
  assert.equal(a.tick({ sent: 0, rx: 0, skips: 0, now: 6000 }), null, "nothing sent: no climb");
  assert.equal(a.tick({ sent: 5000, rx: 5000, skips: 0, now: 6100 }).kbps, 1150);
  assert.equal(a.tick({ sent: 9000, rx: 9000, skips: 0, now: 8000 }), null, "the clean clock restarted");
  assert.equal(a.tick({ sent: 9000, rx: 9000, skips: 0, now: 11200 }).kbps, 1200, "capped");
  assert.equal(a.tick({ sent: 19000, rx: 19000, skips: 0, now: 30000 }), null, "at the cap: nothing");
  a.setCaps(500, 30, 31000, 19000);
  assert.equal(a.kbps, 500, "a lower cap clamps at once");
  const low = new A.AutoController(60, 10, 0);
  assert.equal(low.kbps, 60, "a cap under the floor is the start");
  assert.equal(low.tick({ sent: 1e6, rx: 0, skips: 0, now: 2000 }), null, "and the floor: never above the phone's cap");
});

// ── status and the control gate ───────────────────────────────────────────

test("control: on only with the setting AND Accessibility; the reason names what is missing", () => {
  assert.deepEqual(S.controlOf(true, true), { on: true });
  assert.deepEqual(S.controlOf(false, true), { on: false, reason: K.CONTROL_OFF, needs: ["setting"] });
  assert.deepEqual(S.controlOf(true, false), { on: false, reason: K.NEEDS_ACCESSIBILITY, needs: ["accessibility"] });
  assert.deepEqual(S.controlOf(false, false), { on: false, reason: `${K.CONTROL_OFF} ${K.NEEDS_ACCESSIBILITY}`, needs: ["setting", "accessibility"] });
  assert.deepEqual(S.controlOf(false, null).needs, ["setting"]);
  // Accessibility not known yet: no gate is named, so the view offers no button it cannot back.
  assert.equal(S.controlOf(true, null).on, false);
  assert.equal(S.controlOf(true, null).needs, undefined);
});

test("status: helper fields mapped, a bad one absent, the host's bitrate and measured fps win", () => {
  const st = S.desktopStatus({
    helper: { t: "status", state: "running", width: 1280, height: 800, srcWidth: 2560, srcHeight: "1600", fps: 30, codec: "vp9", accessibility: true, reason: "  " },
    measuredFps: 14.96, bitrateKbps: 700, control: true,
  });
  assert.deepEqual(st, { state: "running", control: { on: true }, width: 1280, height: 800, srcWidth: 2560, fps: 15, bitrateKbps: 700 });
  const err = S.desktopStatus({ helper: { state: "error", reason: K.NEEDS_SCREEN_RECORDING, codec: "h264" }, measuredFps: null, bitrateKbps: 700, control: false });
  assert.deepEqual(err, { state: "error", reason: K.NEEDS_SCREEN_RECORDING, codec: "h264", control: { on: false, reason: K.CONTROL_OFF, needs: ["setting"] } });
  assert.equal(S.desktopStatus({ helper: null, measuredFps: null, bitrateKbps: 1000, control: false }).state, "starting");
});

test("scroll: the phone's fingers-down is the helper's content-up, in points", () => {
  assert.deepEqual(helperScroll({ k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 240 }, 2), { k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: -120 });
  assert.deepEqual(helperScroll({ k: "scroll", x: 0, y: 0, dx: -30, dy: 0 }, 1), { k: "scroll", x: 0, y: 0, dx: 30, dy: 0 });
  assert.equal(helperScroll({ k: "scroll", x: 0, y: 0, dx: 0, dy: 1 }, 4), null, "rounds to nothing: dropped");
  for (const s of [null, 0, -2, NaN, undefined]) assert.equal(helperScroll({ k: "scroll", x: 0, y: 0, dx: 0, dy: 240 }, s), null, `no known scale (${s}): dropped, never sized by a guess`);
});

// ── the helper binary ──────────────────────────────────────────────────────

function fakeRunner(script) {
  const calls = [];
  const run = async (file, args, timeoutMs, env) => { calls.push([file, ...args]); return script(file, args, timeoutMs, env); };
  return { run, calls };
}

test("helper build: one build for concurrent callers, rebuilt only on a changed hash, and a rebuild is said", async () => {
  const state = join(WORK, "bin-cache");
  const src = join(WORK, "src"); mkdirSync(src, { recursive: true });
  let hash = "aaaa";
  const logs = [];
  const r = fakeRunner(async (_f, args) => {
    if (args[1] === "--hash") return { code: 0, stdout: hash + "\n", stderr: "" };
    await sleep(50);
    mkdirSync(join(state, "bin"), { recursive: true });
    writeFileSync(args[1], "#!/bin/sh\n"); writeFileSync(args[1] + ".srchash", hash + "\n");
    return { code: 0, stdout: "", stderr: "" };
  });
  let now = 0;
  const bin = new HelperBin({ stateDir: state, sourceDir: src, log: (m) => logs.push(m), run: r.run, now: () => now });
  assert.equal(bin.state().kind, "unknown");
  const [x, y] = await Promise.all([bin.ensure(), bin.ensure()]);
  assert.deepEqual([x.ok, y.ok], [true, true]);
  assert.equal(r.calls.filter((c) => c[2] !== "--hash").length, 1, "one build");
  assert.equal(bin.state().kind, "current");
  assert.equal(bin.state().rebuiltAt, undefined, "a first build resets no grants");
  now += 20_000;
  await bin.ensure();
  assert.equal(r.calls.filter((c) => c[2] !== "--hash").length, 1, "same hash: no build");
  hash = "bbbb"; now += 20_000;
  assert.equal((await bin.check()).kind, "stale");
  await bin.ensure();
  assert.equal(r.calls.filter((c) => c[2] !== "--hash").length, 2);
  assert.ok(bin.state().rebuiltAt, "a rebuild over an existing binary is remembered");
  assert.ok(logs.some((l) => /source changed.*granted again/.test(l)), "and said in the log");
});

test("helper build: the identity build.sh signs with comes from the brand table, and is part of the hash", async () => {
  const id = helperIdentity();
  assert.equal(id.WP_DESKTOP_ID, "dev.waterplane.wp-desktop", "stable: macOS keys the grant on it");
  const seen = [];
  const r = fakeRunner(async (_f, args, _t, env) => { seen.push(env); return args[1] === "--hash" ? { code: 0, stdout: "aaaa", stderr: "" } : { code: 3, stdout: "", stderr: "x" }; });
  const bin = new HelperBin({ stateDir: join(WORK, "idbin"), sourceDir: WORK, log: () => {}, run: r.run, now: () => 0 });
  await bin.ensure();
  assert.ok(seen.length >= 2 && seen.every((e) => e && e.WP_DESKTOP_ID === id.WP_DESKTOP_ID && e.WP_DESKTOP_NAME === id.WP_DESKTOP_NAME), "--hash and the build both get it");
  // The real script's --hash (hashes, compiles nothing): a different identifier is a different binary.
  const sh = fileURLToPath(new URL("../helper/build.sh", import.meta.url));
  const h = (e) => execFileSync("/bin/bash", [sh, "--hash"], { env: { ...process.env, ...e }, encoding: "utf8" }).trim();
  assert.equal(h(id), h(id));
  assert.notEqual(h(id), h({ ...id, WP_DESKTOP_ID: "other.wp-desktop" }));
});

test("helper build: no swiftc is the xcode-select sentence, and not retried for a minute", async () => {
  let builds = 0, now = 0;
  const r = fakeRunner(async (_f, args) => (args[1] === "--hash" ? { code: 0, stdout: "cccc", stderr: "" } : (builds++, { code: 3, stdout: "", stderr: "build.sh: no swiftc" })));
  const bin = new HelperBin({ stateDir: join(WORK, "nobin"), sourceDir: WORK, log: () => {}, run: r.run, now: () => now });
  assert.deepEqual(await bin.ensure(), { ok: false, reason: K.NO_TOOLCHAIN });
  assert.deepEqual(await bin.ensure(), { ok: false, reason: K.NO_TOOLCHAIN });
  assert.equal(builds, 1);
  now += 61_000;
  await bin.ensure();
  assert.equal(builds, 2);
  const none = new HelperBin({ stateDir: WORK, sourceDir: null, log: () => {} });
  assert.deepEqual(await none.ensure(), { ok: false, reason: K.NO_SOURCE });
});

// ── probe and setup rows ──────────────────────────────────────────────────

test("probe: off macOS in words; on macOS the helper's answer, cached", async () => {
  const bin = new HelperBin({ stateDir: WORK, sourceDir: null, prebuilt: FAKE, log: () => {} });
  const linux = new Prober({ platform: "linux", bin, noCapture: false, control: () => false });
  assert.deepEqual(await linux.probe(), { available: false, reason: K.NOT_MAC, screenRecording: null, accessibility: null, controlEnabled: false, displays: [] });
  let runs = 0;
  const out = JSON.stringify({ screenRecording: false, accessibility: true, responsibleSelf: true, displays: [{ id: 4, width: 3840, height: 2160, scale: 2, main: true, bounds: {} }, { id: "x" }] });
  const p = new Prober({ platform: "darwin", bin, noCapture: true, control: () => true, run: async (_f, args) => { runs++; assert.deepEqual(args, ["probe", "--no-capture"]); return { code: 0, stdout: out, stderr: "" }; } });
  const a = await p.probe();
  assert.deepEqual(a, { available: true, screenRecording: false, accessibility: true, controlEnabled: true, displays: [{ id: 4, width: 3840, height: 2160, scale: 2, main: true }] });
  await p.probe();
  assert.equal(runs, 1, "cached");
  const { parseProbe } = await import(`${D}/host/probe.mjs`);
  const noScale = parseProbe(JSON.stringify({ displays: [{ id: 1, width: 1440, height: 900, main: true }, { id: 2, width: 800, height: 600, scale: 0 }] }));
  assert.deepEqual(noScale.displays.map((d) => "scale" in d), [false, false], "a scale the helper did not say is absent, never 1");
});

test("setup rows: none off macOS or before first use; the right sentence per grant; Accessibility only matters with control on", () => {
  const bin = new HelperBin({ stateDir: WORK, sourceDir: null, prebuilt: FAKE, log: () => {} });
  const opened = [];
  const cached = { screenRecording: false, accessibility: false, responsibleSelf: false, displays: [] };
  const prober = { cached: () => cached, refreshIfBuilt: async () => {}, forget() {} };
  let control = false;
  const deps = { platform: "darwin", bin, prober, control: () => control, openUrl: (u) => opened.push(u) };
  assert.deepEqual(desktopRows({ ...deps, platform: "linux" }), []);
  const unused = new HelperBin({ stateDir: join(WORK, "unused"), sourceDir: WORK, log: () => {}, run: async () => ({ code: 0, stdout: "dddd", stderr: "" }) });
  assert.deepEqual(desktopRows({ ...deps, bin: unused, prober: { ...prober, cached: () => null } }), [], "never used: no rows on every repo's sheet");
  let rows = Object.fromEntries(desktopRows(deps).map((r) => [r.id, r]));
  assert.ok(Object.values(rows).every((r) => r.scope === "host"), "host scope: no repo rollup counts them");
  assert.equal(rows["desktop-helper"].status, "pass");
  assert.equal(rows["desktop-screen-recording"].status, "fail");
  assert.ok(rows["desktop-screen-recording"].detail.startsWith(K.NEEDS_SCREEN_RECORDING) && rows["desktop-screen-recording"].detail.includes(FAKE), "names the path for +");
  assert.equal(rows["desktop-accessibility"].status, "pass", "control off: not needed");
  assert.equal(rows["desktop-responsible"].detail, K.NOT_RESPONSIBLE);
  assert.match(rows["desktop-control"].detail, /Control is off/);
  control = true;
  rows = Object.fromEntries(desktopRows(deps).map((r) => [r.id, r]));
  assert.equal(rows["desktop-accessibility"].status, "fail");
  assert.match(rows["desktop-control"].detail, /reach every app on this desktop/);
  const fixes = desktopFixes({ ...deps, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
  assert.deepEqual(Object.keys(fixes).sort(), [FIX_ACCESSIBILITY, FIX_BUILD, FIX_SCREEN].sort());
  assert.equal(rows["desktop-screen-recording"].fix, FIX_SCREEN);
  assert.equal(rows["desktop-accessibility"].fix, FIX_ACCESSIBILITY);
  assert.match(rows["desktop-screen-recording"].detail, /Tap Fix and macOS asks/);
});

test("setup fix: Ask macOS runs `wp-desktop request`, says so, and opens the pane only as the fallback", async () => {
  const ok = fakeHelper("req", {});
  const bin = new HelperBin({ stateDir: WORK, sourceDir: null, prebuilt: ok.bin, log: () => {} });
  const opened = [], logs = [];
  let forgot = 0;
  const prober = { cached: () => null, refreshIfBuilt: async () => {}, forget: () => { forgot++; } };
  const deps = { platform: "darwin", bin, prober, control: () => true, openUrl: (u) => opened.push(u), log: (m) => logs.push(m) };
  const requests = () => ok.lines().filter((l) => l.argv?.[0] === "request").map((l) => l.argv);

  // 1. first tap: the dialog is asked for, in words; no pane opened
  const out = desktopFixes(deps)[FIX_SCREEN]();
  assert.equal(out.applied, true);
  // macOS's dialog has no Allow: its "Open System Settings" only opens the pane, and the note must say so.
  assert.ok(out.note.startsWith("macOS is asking on the desktop's screen."), out.note);
  assert.match(out.note, /grants nothing by itself/);
  assert.doesNotMatch(out.note, /Allow/);
  assert.equal(out.note.startsWith(MACOS_IS_ASKING), true);
  assert.ok(await until(() => requests().length === 1 && forgot === 1), "the helper ran `request screen`, and the probe was forgotten");
  assert.deepEqual(requests(), [["request", "screen"]]);
  assert.deepEqual(opened, []);

  // 2. the same build, Screen Recording again: macOS will not ask twice, so the pane opens and nothing runs
  const again = desktopFixes(deps)[FIX_SCREEN]();
  assert.deepEqual(opened, [K.PANE_SCREEN]);
  assert.match(again.note, /only once per build.*Opened System Settings → Privacy & Security → Screen Recording/);
  await sleep(150);
  assert.equal(requests().length, 1);

  // 3. Accessibility has its own request, and asks again every tap (macOS prompts each time)
  assert.ok(desktopFixes(deps)[FIX_ACCESSIBILITY]().note.startsWith(MACOS_IS_ASKING));
  assert.ok(await until(() => requests().length === 2));
  assert.deepEqual(requests()[1], ["request", "accessibility"]);
  desktopFixes(deps)[FIX_ACCESSIBILITY]();
  assert.ok(await until(() => requests().length === 3));

  // 4. a helper that cannot run: the pane opens after all, the log says why, and the next tap asks again
  const bad = fakeHelper("reqfail", { FAKE_REQUEST: "fail" });
  const badBin = new HelperBin({ stateDir: WORK, sourceDir: null, prebuilt: bad.bin, log: () => {} });
  opened.length = 0;
  assert.ok(desktopFixes({ ...deps, bin: badBin })[FIX_SCREEN]().note.startsWith(MACOS_IS_ASKING));
  assert.ok(await until(() => opened.length === 1));
  assert.deepEqual(opened, [K.PANE_SCREEN]);
  assert.ok(logs.some((l) => /request screen failed: wp-desktop: request: boom/.test(l)), logs.join("|"));
  assert.equal(existsSync(`${bad.bin}.asked-screen`), false, "a failed ask is not remembered as asked");

  // 5. not built: it cannot ask, so the pane opens at once, in words
  const unbuilt = new HelperBin({ stateDir: join(WORK, "unbuilt"), sourceDir: WORK, log: () => {}, run: async () => ({ code: 0, stdout: "eeee", stderr: "" }) });
  opened.length = 0;
  const n = desktopFixes({ ...deps, bin: unbuilt })[FIX_SCREEN]();
  assert.deepEqual(opened, [K.PANE_SCREEN]);
  assert.match(n.note, /not built yet, so it cannot ask/);
  assert.equal(desktopFixes({ ...deps, platform: "linux" })[FIX_SCREEN]().applied, false);
});

// ── a stream over the fake helper ─────────────────────────────────────────

/** A wrapper that runs the fake helper in one mode, logging to its own file. */
function fakeHelper(name, env) {
  const log = join(WORK, `${name}.log`);
  const bin = join(WORK, `${name}.sh`);
  writeFileSync(bin, `#!/bin/sh\n${Object.entries({ ...env, FAKE_LOG: log }).map(([k, v]) => `${k}='${v}'`).join(" ")} exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, lines };
}

let subN = 0;
/** A stand-in for the core's PluginStreamSub: records frames and statuses; `end` closes like the core does. */
function fakeSub(handlers) {
  const sub = {
    id: ++subN, key: `desktop:${subN}`, params: null, backlogBytes: 0, sentBytes: 0, lastAck: null,
    frames: [], statuses: [], events: [], ended: null, result: "sent",
    send(payload, o) {
      if (this.ended) return "ended";
      const f = { len: payload.byteLength, first: payload[0], ...o };
      this.frames.push(f); this.events.push({ frame: f });
      if (this.result === "sent") this.sentBytes += payload.byteLength;
      return this.result;
    },
    status(d) { if (this.ended) return "the stream has ended"; this.statuses.push(d); this.events.push({ status: d }); return null; },
    end(reason, cause) { if (this.ended) return; this.ended = reason; this.cause = cause === "replaced" ? "replaced" : "plugin"; handlers.close(this, this.cause); },
  };
  return sub;
}

function rig(helper, o = {}) {
  const logs = [];
  let control = o.control ?? false;
  const desk = createDesktop({
    platform: o.platform ?? "darwin", os: o.os, stateDir: WORK, sourceDir: null, prebuilt: helper.bin, synthetic: false,
    log: (m) => logs.push(m), control: () => control, termMs: 200, killMs: 600, tickMs: 100,
  });
  const open = async (params = {}) => {
    const sub = fakeSub(desk.handlers);
    const r = await desk.handlers.open(sub, params);
    for (const pid of desk.pids()) opened.add(pid);
    return { sub, refusal: r };
  };
  return { desk, logs, open, setControl: (v) => { control = v; desk.controlChanged(v); } };
}

test("stream: frames flow, the config is the cleaned params with Auto's bitrate, and status says control is off", async () => {
  const h = fakeHelper("flow", {});
  const { desk, logs, open } = rig(h);
  const { sub, refusal } = await open({ codec: "h264", fps: 30, bitrateKbps: 4000, auto: true, evil: "x", maxWidth: 999 });
  assert.equal(refusal, undefined);
  assert.ok(await until(() => sub.frames.length >= 5), "frames arrive");
  assert.deepEqual([sub.frames[0].key, sub.frames[0].droppable, sub.frames[0].kind], [true, false, W.FRAME_H264], "an H.264 key is never droppable");
  assert.deepEqual([sub.frames[1].key, sub.frames[1].droppable], [false, true]);
  const cfg = h.lines().find((l) => l.t === "config");
  assert.equal(cfg.bitrateKbps, A.AUTO_START_KBPS, "Auto starts at its own pick under the cap");
  assert.equal(cfg.maxWidth, 999);
  assert.equal("evil" in cfg || "auto" in cfg, false, "only known fields reach the helper");
  assert.ok(await until(() => sub.statuses.some((s) => s.state === "running")));
  const st = sub.statuses.findLast((s) => s.state === "running");
  assert.deepEqual(st.control, { on: false, reason: `${K.CONTROL_OFF} ${K.NEEDS_ACCESSIBILITY}`, needs: ["setting", "accessibility"] }, "both missing: both named");
  assert.equal(st.bitrateKbps, A.AUTO_START_KBPS);
  assert.ok(logs.some((l) => /^stream open id=desktop:\d+ codec=h264 source=display maxWidth=999 fps=30 auto≤4000kbps control=off/.test(l)), logs.join("\n"));
  sub.end("test over");
  assert.ok(await until(() => desk.pids().length === 0));
});

test("stream: input is dropped with control off (one log line), forwarded once when on, malformed never", async () => {
  const h = fakeHelper("gate", { FAKE_AX: "1" });
  const { desk, logs, open, setControl } = rig(h);
  const { sub } = await open({});
  await until(() => sub.statuses.length > 0);
  for (let i = 0; i < 3; i++) desk.handlers.input(sub, { k: "click", b: "l", x: 0.5, y: 0.5, n: 1 });
  await sleep(150);
  assert.equal(h.lines().filter((l) => l.t === "input").length, 0, "nothing reached the helper");
  assert.equal(logs.filter((l) => /control is off/.test(l)).length, 1, "one log line, not one per event");
  setControl(true);
  assert.ok(logs.some((l) => /^control enabled/.test(l)));
  assert.ok(await until(() => sub.statuses.at(-1)?.control?.on === true), "the view hears control is on at once");
  // No probe has said the display's scale yet: a scroll is dropped (one log line) and a probe asked for.
  let probes = 0;
  desk.prober.probe = async () => { probes++; return { available: true, screenRecording: true, accessibility: true, controlEnabled: true, displays: [] }; };
  desk.handlers.input(sub, { k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 100 });
  desk.handlers.input(sub, { k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 100 });
  assert.equal(logs.filter((l) => /scroll dropped: the display's backing scale is not known yet/.test(l)).length, 1, "said once");
  assert.ok(probes >= 1, "a probe was asked for, so the next scroll knows");
  desk.prober.cached = () => ({ screenRecording: true, accessibility: true, responsibleSelf: true, displays: [{ id: 1, width: 1440, height: 900, scale: 2, main: true }] });
  desk.handlers.input(sub, { k: "click", b: "l", x: 0.25, y: 0.75, n: 1, extra: "dropped" });
  desk.handlers.input(sub, { k: "click", b: "z", x: 0.25, y: 0.75 });
  desk.handlers.input(sub, { k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 100 });
  assert.ok(await until(() => h.lines().filter((l) => l.t === "input").length === 2));
  await sleep(100);
  const inputs = h.lines().filter((l) => l.t === "input").map((l) => l.ev);
  assert.deepEqual(inputs, [{ k: "click", b: "l", x: 0.25, y: 0.75, n: 1 }, { k: "scroll", x: 0.5, y: 0.5, dx: -0, dy: -50 }].map((e) => JSON.parse(JSON.stringify(e))),
    "100 source px on a 2× display is 50 points");
  assert.equal(logs.filter((l) => /not a valid desktop input/.test(l)).length, 1);
  sub.end("test over");
  assert.ok(await until(() => desk.pids().length === 0));
});

test("stream: params re-steer with a config, a crop change asks for its keyframe, keyframe passes through", async () => {
  const h = fakeHelper("params", {});
  const { desk, open } = rig(h);
  const { sub } = await open({ auto: false, bitrateKbps: 800, fps: 15 });
  await until(() => h.lines().some((l) => l.t === "config"));
  desk.handlers.params(sub, { auto: false, bitrateKbps: 800, fps: 15, maxWidth: 640 });
  await until(() => h.lines().filter((l) => l.t === "config").length === 2);
  assert.equal(h.lines().filter((l) => l.t === "keyframe").length, 0, "a size change alone: the helper keys it itself");
  desk.handlers.params(sub, { auto: false, bitrateKbps: 800, fps: 15, maxWidth: 640, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
  assert.ok(await until(() => h.lines().filter((l) => l.t === "keyframe").length === 1), "crop ⇒ keyframe");
  const lines = h.lines();
  assert.deepEqual(lines.filter((l) => l.t === "config").at(-1).crop, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.equal(lines.filter((l) => l.t === "config").at(-1).bitrateKbps, 800, "no Auto: the cap is the bitrate");
  desk.handlers.keyframe(sub);
  assert.ok(await until(() => h.lines().filter((l) => l.t === "keyframe").length === 2));
  sub.end("test over");
  assert.ok(await until(() => desk.pids().length === 0));
});

for (const lag of [false, true]) {
  test(`stream: a status naming a region comes before that region's first frame${lag ? ", even when an old-region key was still in the encoder" : ""}`, async () => {
    const h = fakeHelper(`region${lag ? "-lag" : ""}`, lag ? { FAKE_LAG: "1" } : {});
    const { desk, open } = rig(h);
    const { sub } = await open({ auto: false, bitrateKbps: 800, fps: 15 });
    const crops = [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.25 }, null];
    for (const crop of crops) {
      assert.ok(await until(() => sub.frames.length >= 3 && sub.frames.every((f) => f.first >= 1)));
      const before = sub.frames.length;
      desk.handlers.params(sub, { auto: false, bitrateKbps: 800, fps: 15, ...(crop ? { crop } : {}) });
      assert.ok(await until(() => sub.frames.length >= before + 4), "frames of the new region arrive");
    }
    // Walk the one ordered stream the phone sees: every frame is of the region the newest status named.
    let named = null;
    const seen = [];
    let lateOldKeys = 0;
    for (const e of sub.events) {
      if (e.status) {
        if (e.status.regionSeq !== undefined) { named = e.status; if (!seen.includes(named.regionSeq)) seen.push(named.regionSeq); }
        continue;
      }
      assert.ok(named, "no frame before a status that names a region");
      assert.equal(e.frame.first, named.regionSeq, `a frame of region ${e.frame.first} came while region ${named.regionSeq} was named`);
    }
    // The late key of the old region sits between the config and the announcement: it is the last frame before it.
    const evs = sub.events;
    for (let i = 1; i < evs.length; i++) {
      if (evs[i].status?.regionSeq !== undefined && evs[i - 1].frame && evs[i - 1].frame.first === evs[i].status.regionSeq - 1 && evs[i - 1].frame.key) lateOldKeys++;
    }
    assert.deepEqual(seen, [1, 2, 3, 4], "each crop change was announced once, in order");
    assert.deepEqual(sub.statuses.findLast((s) => s.regionSeq === 4).crop, { x: 0, y: 0, w: 1, h: 1 }, "the full source is named as the whole, not left out");
    assert.deepEqual(sub.statuses.find((s) => s.regionSeq === 2).crop, crops[0]);
    if (lag) assert.ok(lateOldKeys >= 2, `an old-region key really came after the config and before its announcement (${lateOldKeys})`);
    sub.end("test over");
    assert.ok(await until(() => desk.pids().length === 0));
  });
}

test("control wording: the host's sentence, shown as it is on the phone, says \"Control is off\" once or not at all", async () => {
  const { controlBlock } = await import("../web/words.ts");
  for (const [setting, ax] of [[false, false], [false, true], [false, null], [true, false], [true, null], [true, true]]) {
    const status = S.desktopStatus({ helper: { t: "status", state: "running", accessibility: ax ?? undefined }, measuredFps: null, bitrateKbps: 800, control: setting });
    const line = controlBlock("touch", status);
    if (status.control.on) { assert.equal(line, null); continue; }
    assert.ok((line.match(/control is off/gi) ?? []).length <= 1, line);
    assert.ok(line.startsWith(status.control.reason), "the host's reason is the start of the line, untouched");
  }
  assert.equal((controlBlock("touch", S.desktopStatus({ helper: null, measuredFps: null, bitrateKbps: 800, control: false })).match(/control is off/gi) ?? []).length, 1);
});

test("status: the region the helper names passes through checked; a bad one is absent, never guessed", () => {
  const base = { helper: { t: "status", state: "running", accessibility: true }, measuredFps: null, bitrateKbps: 800, control: true };
  const ok = S.desktopStatus({ ...base, helper: { ...base.helper, crop: { x: 0, y: 0, w: 1, h: 1 }, regionSeq: 3 } });
  assert.deepEqual([ok.crop, ok.regionSeq], [{ x: 0, y: 0, w: 1, h: 1 }, 3]);
  for (const crop of [null, "x", { x: 0, y: 0, w: 0, h: 1 }, { x: 0.8, y: 0, w: 0.5, h: 1 }, { x: "0", y: 0, w: 1, h: 1 }]) {
    assert.equal("crop" in S.desktopStatus({ ...base, helper: { ...base.helper, crop } }), false, JSON.stringify(crop));
  }
  assert.equal("regionSeq" in S.desktopStatus({ ...base, helper: { ...base.helper, regionSeq: 1.5 } }), false);
  assert.equal("crop" in S.desktopStatus({ ...base, helper: { t: "status", state: "running" } }), false, "an older helper names none");
});

test("stream: Auto cuts the bitrate on skipped frames with a cheap bitrate line", async () => {
  const h = fakeHelper("auto", {});
  const { desk, open } = rig(h);
  const { sub } = await open({ auto: true, bitrateKbps: 4000, fps: 30 });
  await until(() => sub.frames.length > 3);
  sub.result = "skipped";
  await sleep(1200); // past the controller's one-second gap
  desk.handlers.ack(sub);
  assert.ok(await until(() => h.lines().some((l) => l.t === "bitrate")), "a bitrate line");
  assert.equal(h.lines().find((l) => l.t === "bitrate").kbps, 700);
  assert.ok(await until(() => sub.statuses.at(-1)?.bitrateKbps === 700), "the view is told what Auto picked");
  sub.end("test over");
  assert.ok(await until(() => desk.pids().length === 0));
});

test("stream: a third view replaces the OLDEST (cause replaced, in words), never refuses the newest; close frees a slot", async () => {
  const h = fakeHelper("cap", {});
  const { desk, open, logs } = rig(h);
  const a = await open({});
  const b = await open({});
  assert.equal(desk.openCount(), 2);
  await until(() => h.lines().filter((l) => l.start).length === 2);
  // A dropped tunnel leaves a and b on sockets nobody knows are dead: the phone opening now wins.
  const c = await open({});
  assert.equal(c.refusal, undefined, "the newest view opens");
  assert.equal(a.sub.ended, K.REPLACED, "the oldest is told why, in words");
  assert.equal(a.sub.cause, "replaced");
  assert.equal(b.sub.ended, null, "only the oldest goes");
  assert.equal(desk.openCount(), 2);
  assert.ok(logs.some((l) => /^stream replace id=desktop:\d+: a newer view \(id=desktop:\d+\) is opening and the cap is 2$/.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => /^stream close id=desktop:\d+ cause=replaced after/.test(l)));
  assert.ok(await until(() => desk.pids().length === 2, 2000), "the replaced view's helper exits");
  desk.handlers.close(b.sub, "closed");
  assert.ok(logs.some((l) => /^stream close id=desktop:\d+ cause=closed after/.test(l)));
  assert.ok(await until(() => desk.pids().length === 1, 2000), "the closed view's helper exits");
  assert.ok(h.lines().some((l) => l.t === "stop"), "it was told to stop first");
  const d = await open({});
  assert.equal(d.refusal, undefined, "the slot is free again");
  assert.equal(c.sub.ended, null, "a free slot replaces nobody");
  desk.stopAll();
  assert.ok(await until(() => desk.pids().length === 0), "deactivate stops every helper");
  assert.ok([c.sub, d.sub].every((s) => typeof s.ended === "string"), "each view is told why it ended");
});

test("stream: with both slots still OPENING there is nothing to hand over — refused in words", async () => {
  const h = fakeHelper("opening", {});
  const desk = createDesktop({
    platform: "darwin", stateDir: WORK, sourceDir: null, prebuilt: h.bin, synthetic: false, log: () => {}, control: () => false,
    run: undefined, openWaitMs: 200,
  });
  // Hold the build: ensure() never settles, so both opens sit reserved.
  desk.bin.ensure = () => new Promise(() => {});
  const p1 = desk.handlers.open(fakeSub(desk.handlers), {});
  const p2 = desk.handlers.open(fakeSub(desk.handlers), {});
  assert.equal(await desk.handlers.open(fakeSub(desk.handlers), {}), K.TOO_MANY);
  assert.equal(await p1, K.BUILDING);
  assert.equal(await p2, K.BUILDING);
});

test("stream: a helper that ignores stop and SIGTERM is SIGKILLed", async () => {
  const h = fakeHelper("stubborn", { FAKE_MODE: "stubborn" });
  const { desk, open } = rig(h);
  const { sub } = await open({});
  await until(() => h.lines().some((l) => l.t === "config"));
  const [pid] = desk.pids();
  desk.handlers.close(sub, "closed");
  await sleep(400);
  assert.ok(alive(pid), "still there after SIGTERM");
  assert.ok(await until(() => !alive(pid), 2000), "gone after SIGKILL");
  assert.ok(h.lines().some((l) => l.ignored === "SIGTERM"));
});

test("stream: a helper that exits on its own ends the view with a sentence", async () => {
  const h = fakeHelper("die", { FAKE_MODE: "die" });
  const { desk, open, logs } = rig(h);
  const { sub } = await open({});
  assert.ok(await until(() => sub.ended !== null, 3000));
  assert.match(sub.ended, /stopped unexpectedly \(exit code 7\)\. Open the view again/);
  assert.ok(logs.some((l) => /ended on its own: exit 7/.test(l)));
  assert.equal(desk.openCount(), 0);
});

test("stream: refused off macOS, and when the helper cannot start", async () => {
  const h = fakeHelper("linux", {});
  const off = rig(h, { platform: "linux" });
  assert.equal((await off.open({})).refusal, K.NOT_MAC);
  const missing = createDesktop({ platform: "darwin", stateDir: WORK, sourceDir: null, prebuilt: join(WORK, "no-such-helper"), synthetic: false, log: () => {}, control: () => false });
  const r = await missing.handlers.open(fakeSub(missing.handlers), {});
  assert.match(r, /no-such-helper.*not an executable file/);
  assert.equal(missing.openCount(), 0);
});

test("summary: the open log line's params", () => {
  assert.equal(summary(W.cleanDesktopParams({ codec: "jpeg", source: { kind: "window", id: 7 }, maxWidth: 0, fps: 2, auto: false, jpegQuality: 40, grayscale: true })),
    "codec=jpeg source=window:7 maxWidth=native fps=2 4000kbps q=40 gray");
});

// ── Windows (a host in WSL, wp-desktop.exe through interop) ────────────────

test("windows: which desktop a platform means, and where the Windows helper's source and binary are", async () => {
  assert.equal(K.detectDesktopOs("darwin"), "mac");
  assert.equal(K.detectDesktopOs("win32"), null, "a native Windows node is not the supported host (it runs in WSL)");
  assert.equal(K.osOf({ platform: "linux" }), null);
  assert.equal(K.osOf({ platform: "linux", os: "windows" }), "windows", "an explicit os wins over the platform");
  assert.equal(K.osOf({ platform: "darwin", os: null }), null);
  const src = K.helperSourceDir(new URL(`${D}/host/knobs.mjs`, import.meta.url).href, K.HELPER.windows.dir);
  assert.ok(src && existsSync(join(src, "build.sh")) && existsSync(join(src, "Server.cs")), `helper-win found: ${src}`);
  const h1 = execFileSync("/bin/bash", [join(src, "build.sh"), "--hash"], { encoding: "utf8" }).trim();
  assert.match(h1, /^[0-9a-f]{16}$/, "--hash compiles nothing and needs no Windows");
  const bin = new HelperBin({ stateDir: join(WORK, "win"), sourceDir: src, os: "windows", log: () => {} });
  assert.ok(bin.path.endsWith("/bin/wp-desktop.exe"));
});

test("windows: a rebuild forgets no grant (Windows keys none on the binary), and no csc is its own sentence", async () => {
  const state = join(WORK, "winbuild");
  let hash = "aaaa";
  const logs = [];
  const r = fakeRunner(async (_f, args) => {
    if (args[1] === "--hash") return { code: 0, stdout: hash + "\n", stderr: "" };
    mkdirSync(join(state, "bin"), { recursive: true });
    writeFileSync(args[1], "x"); writeFileSync(args[1] + ".srchash", hash + "\n");
    return { code: 0, stdout: "", stderr: "" };
  });
  let now = 0;
  const bin = new HelperBin({ stateDir: state, sourceDir: WORK, os: "windows", log: (m) => logs.push(m), run: r.run, now: () => now });
  assert.equal((await bin.ensure()).ok, true);
  hash = "bbbb"; now += 20_000;
  await bin.ensure();
  assert.equal(bin.state().kind, "current");
  assert.equal(bin.state().rebuiltAt, undefined, "no grants to lose");
  assert.ok(!logs.some((l) => /grant/.test(l)), logs.join("\n"));
  const none = new HelperBin({ stateDir: join(WORK, "wincsc"), sourceDir: WORK, os: "windows", log: () => {},
    run: async (_f, args) => (args[1] === "--hash" ? { code: 0, stdout: "cccc", stderr: "" } : { code: 3, stdout: "", stderr: "no csc" }), now: () => 0 });
  assert.deepEqual(await none.ensure(), { ok: false, reason: K.NO_TOOLCHAIN_WIN });
});

test("windows: a helper that cannot see the signed-in desktop is unavailable in words, never a grant button", async () => {
  const bin = new HelperBin({ stateDir: WORK, sourceDir: null, prebuilt: FAKE, log: () => {} });
  let seen = false;
  const out = (sr) => JSON.stringify({ screenRecording: sr, accessibility: true, responsibleSelf: true, displays: [{ id: 1, width: 2880, height: 1800, scale: 1.75, main: true }] });
  const p = new Prober({ platform: "linux", os: "windows", bin, noCapture: false, control: () => false, run: async () => ({ code: 0, stdout: out(seen), stderr: "" }), ttlMs: 0 });
  const a = await p.probe();
  assert.equal(a.available, false);
  assert.equal(a.reason, K.WIN_NO_DESKTOP);
  assert.equal(a.screenRecording, null, "null, so the phone draws no 'ask for Screen Recording' button");
  seen = true;
  const b = await p.probe();
  assert.deepEqual(b, { available: true, screenRecording: true, accessibility: true, controlEnabled: false, displays: [{ id: 1, width: 2880, height: 1800, scale: 1.75, main: true }] });
});

test("windows: setup rows have no Accessibility or permission-owner row, and the ask fixes say there is nothing to ask", () => {
  const bin = new HelperBin({ stateDir: WORK, sourceDir: null, prebuilt: FAKE, log: () => {} });
  let cached = { screenRecording: false, accessibility: true, responsibleSelf: true, displays: [] };
  const prober = { cached: () => cached, refreshIfBuilt: async () => {}, forget() {} };
  const opened = [];
  const deps = { platform: "linux", os: "windows", bin, prober, control: () => true, openUrl: (u) => opened.push(u) };
  let rows = desktopRows(deps);
  assert.deepEqual(rows.map((r) => r.id), ["desktop-helper", "desktop-screen-recording", "desktop-control"]);
  assert.equal(rows[1].status, "fail");
  assert.equal(rows[1].detail, K.WIN_NO_DESKTOP);
  assert.equal(rows[1].fix, null, "nothing the phone can tap fixes a session");
  assert.match(rows[2].detail, /administrator/);
  assert.ok(rows.every((r) => !/macOS|System Settings/.test(r.detail)), "no Mac words on Windows");
  cached = { ...cached, screenRecording: true };
  rows = desktopRows(deps);
  assert.equal(rows[1].status, "pass");
  const fixes = desktopFixes(deps);
  assert.deepEqual(fixes[FIX_SCREEN](), { applied: false, note: WINDOWS_ASKS_NOTHING });
  assert.deepEqual(fixes[FIX_ACCESSIBILITY](), { applied: false, note: WINDOWS_ASKS_NOTHING });
  assert.deepEqual(opened, [], "and opens no pane");
});

test("windows: a stream opens on a WSL host (os windows) and is refused on plain Linux", async () => {
  const h = fakeHelper("winflow", {});
  const win = rig(h, { platform: "linux", os: "windows" });
  const { sub, refusal } = await win.open({ codec: "h264" });
  assert.equal(refusal, undefined);
  assert.ok(await until(() => sub.frames.length >= 2), "frames arrive");
  win.desk.stopAll();
  const lin = rig(h, { platform: "linux" });
  assert.equal((await lin.open({})).refusal, K.NOT_MAC);
});
