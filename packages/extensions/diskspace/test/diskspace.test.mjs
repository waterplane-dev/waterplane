/**
 * The disk-space host half over a fake $HOME, code root and scratch root in a temp dir — never the
 * real disk. Pins the delete gate: an unknown id, a path-shaped id, a show-only id and a symlink
 * that escapes are all REFUSED, and what sits outside survives; a size that cannot be measured is
 * unknown, never 0; build output must be next to a manifest AND ignored by git; scratchpads must be
 * idle for a day; an ollama tag must be one `ollama list` names; the large-file find is bounded.
 *
 *     node --test packages/extensions/diskspace/test/diskspace.test.mjs   (after the host build)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DISKSPACE_DIST: a scratch build of the host half (a session must not write into packages/host/dist).
const D = process.env.DISKSPACE_DIST ?? "../../../host/dist/extensions/diskspace";
const { createEngine, serve } = await import(`${D}/host/index.mjs`);
const { idOf, parseOllamaList, ollamaSizeKb, buildCandidates } = await import(`${D}/host/candidates.mjs`);

const put = (p, body = "x".repeat(4096)) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
const DAY = 24 * 3600_000;
const old = (p) => { const t = (Date.now() - 3 * DAY) / 1000; utimesSync(p, t, t); };

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wp-disk-")));
  const home = join(base, "home"), root = join(home, "dev"), tmpRoot = join(base, "tmp", "claude-501"), outside = join(base, "outside");
  put(join(home, ".gradle/caches/modules/a.jar"));
  put(join(home, "Library/Caches/pip/http/x"));
  put(join(home, ".cache/huggingface/hub/models--org--name/blobs/b1"));
  put(join(outside, "precious.txt"), "keep me");
  // a repo with real build output (ignored), a source folder named build (tracked), and node_modules
  const app = join(root, "app");
  put(join(app, "package.json"), "{}");
  put(join(app, ".gitignore"), "build/\nnode_modules/\n");
  put(join(app, "build/out.js"));
  put(join(app, "node_modules/dep/index.js"));
  const lib = join(root, "lib");
  put(join(lib, "package.json"), "{}");
  put(join(lib, "build/icon.png"));
  put(join(root, "plain/build/x.txt")); // no manifest beside it
  for (const d of [app, lib]) {
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["add", "-A"], { cwd: d });
  }
  // scratchpads: one idle for days, one fresh
  put(join(tmpRoot, "proj/old-session/scratchpad/f.txt"));
  for (const p of ["proj/old-session/scratchpad/f.txt", "proj/old-session/scratchpad", "proj/old-session"]) old(join(tmpRoot, p));
  put(join(tmpRoot, "proj/live-session/scratchpad/f.txt"));
  // a fake ollama: lists two tags sharing an id, logs every argv
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(base, "ollama.log");
  writeFileSync(join(bin, "ollama"), `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$1" = list ]; then\nprintf 'NAME              ID              SIZE      MODIFIED\\nqwen3:30b         0b28110b7a33    18 GB     5 weeks ago\\nqwen3:latest      0b28110b7a33    18 GB     5 weeks ago\\ngemma:2b          aabbccddeeff    1.6 GB    2 days ago\\n'\nfi\n`);
  chmodSync(join(bin, "ollama"), 0o755);
  const roots = {
    home, root, tmpRoot, androidSdk: join(home, "Library/Android/sdk"), duBin: "/usr/bin/du", gitBin: "git", findBin: "/usr/bin/find",
    ollamaBin: join(bin, "ollama"), duTimeoutMs: 20_000, concurrency: 4, walkDepth: 8, walkBudget: 10_000, tmpMinAgeMs: DAY,
    largeLimitMs: 20_000, largeMinSize: "+1000k", now: () => Date.now(),
  };
  return { base, home, root, tmpRoot, outside, bin, log, roots, done: () => rmSync(base, { recursive: true, force: true }) };
}

function harness(roots) {
  let pushes = 0;
  const handlers = new Map();
  const api = { handle: (m, fn) => { handlers.set(m, fn); return () => handlers.delete(m); }, push: () => { pushes++; return null; } };
  const engine = createEngine(roots, () => { pushes++; });
  serve(api, engine);
  const call = async (m, args = {}) => JSON.parse(JSON.stringify(await handlers.get(m)(JSON.parse(JSON.stringify(args)))));
  const scanned = async () => { await call("scan"); await engine.idle(); return call("state"); };
  return { engine, call, scanned, pushes: () => pushes };
}

const byLabel = (rows, re) => rows.find((r) => re.test(r.label));

test("a scan lists the fixed caches, real build output, idle scratchpads and models — and shows node_modules without a delete id", async () => {
  const f = fixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    assert.equal(s.scanning, false);
    assert.ok(s.scan.volume && s.scan.volume.totalKb > 0);
    const temp = s.scan.temp.map((e) => e.label);
    assert.ok(temp.includes("~/.gradle/caches"));
    assert.ok(temp.includes("~/Library/Caches/pip"));
    assert.ok(temp.includes("~/dev/app/build"), temp.join(", "));
    assert.ok(!temp.some((l) => l.includes("lib/build")), "a build folder git tracks is source, not output");
    assert.ok(!temp.some((l) => l.includes("plain/build")), "a build folder with no manifest beside it is not offered");
    const tmp = s.scan.temp.find((e) => e.group === "scratchpads");
    assert.ok(tmp, "the idle scratchpad row");
    assert.match(tmp.note, /^1 session folder$/);
    assert.ok(s.code.notes.some((n) => /not ignored by git/.test(n)), "the walk's sentences are the code walk's");
    assert.equal(s.code.onTap, false, "on a Mac the walk is part of every scan");
    assert.ok(s.code.at != null && !s.code.running);
    for (const e of s.scan.temp) assert.ok(e.sizeKb > 0, `${e.label} measured`);
    const hf = byLabel(s.scan.models, /^org\/name$/);
    assert.ok(hf && hf.sizeKb > 0);
    const q = s.scan.models.filter((e) => e.group === "Ollama");
    assert.equal(q.length, 3);
    assert.match(byLabel(q, /^qwen3:30b$/).note, /Same ID as qwen3:latest/);
    assert.equal(byLabel(q, /^gemma:2b$/).note, "modified 2 days ago");
    const nm = s.scan.show.find((e) => e.group === "node_modules");
    assert.ok(nm && /^nm:/.test(nm.id));
    assert.ok(h.pushes() >= 2, "a push when the scan starts and when it ends");
  } finally { f.done(); }
});

test("remove refuses an unknown id, a path-shaped id and a show-only id — before anything is touched", async () => {
  const f = fixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    const refuse = async (id, re) => {
      await assert.rejects(() => h.call("remove", { id }), re);
    };
    await refuse("cache:0123456789abcdef", /not a candidate of the last scan/);
    await refuse(f.outside, /never a path/);
    await refuse("../../outside", /never a path/);
    await refuse(`cache:${f.outside}`, /never a path/);
    await refuse(idOf("cache", f.outside), /not a candidate of the last scan/); // well-formed, but not in the scan
    await refuse(s.scan.show.find((e) => e.group === "node_modules").id, /never a path/);
    await refuse(undefined, /never a path/);
    await refuse({ path: f.outside }, /never a path/);
    assert.equal(readFileSync(join(f.outside, "precious.txt"), "utf8"), "keep me");
    assert.ok(existsSync(join(f.root, "app/node_modules/dep/index.js")));
    assert.equal(s.deleting.length, 0);
  } finally { f.done(); }
});

test("a cache swapped for a symlink to elsewhere after the scan is refused, and the target survives", async () => {
  const f = fixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    const pip = byLabel(s.scan.temp, /^~\/Library\/Caches\/pip$/);
    renameSync(join(f.home, "Library/Caches/pip"), join(f.base, "pip-moved"));
    symlinkSync(f.outside, join(f.home, "Library/Caches/pip"));
    await h.call("remove", { id: pip.id });
    await h.engine.idle();
    const after = await h.call("state");
    const r = after.results[0];
    assert.equal(r.ok, false);
    assert.match(r.error, /symlink/);
    assert.equal(readFileSync(join(f.outside, "precious.txt"), "utf8"), "keep me");
  } finally { f.done(); }
});

test("a symlink whose parent escapes (hub linked elsewhere) is never offered, and its id is refused", async () => {
  const f = fixture();
  try {
    put(join(f.outside, "models--evil--x/blobs/b"));
    symlinkSync(join(f.outside, "models--evil--x"), join(f.home, ".cache/huggingface/hub/models--evil--x"));
    // a build dir that is a symlink out of the root: the walk does not follow it
    symlinkSync(f.outside, join(f.root, "app/.next"));
    const h = harness(f.roots);
    const s = await h.scanned();
    assert.ok(!s.scan.models.some((e) => e.label === "evil/x"), "the escaping symlink is not offered");
    assert.ok(s.scan.notes.some((n) => /evil\/x: is a symlink/.test(n)), s.scan.notes.join(" | "));
    assert.ok(!s.scan.temp.some((e) => e.label.includes(".next")));
    const evilId = idOf("hf", join(f.home, ".cache/huggingface/hub/models--evil--x"));
    await assert.rejects(() => h.call("remove", { id: evilId }), /not a candidate of the last scan/);
    assert.ok(existsSync(join(f.outside, "models--evil--x/blobs/b")));
  } finally { f.done(); }
});

test("a real delete removes exactly the candidate, records it, re-measures that row and the header", async () => {
  const f = fixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    const build = byLabel(s.scan.temp, /app\/build$/);
    const r = await h.call("remove", { id: build.id });
    assert.deepEqual(r, { accepted: true, label: "~/dev/app/build" });
    await h.engine.idle();
    const after = await h.call("state");
    assert.equal(after.results[0].ok, true, after.results[0].error);
    assert.equal(after.results[0].sizeKb, build.sizeKb);
    assert.ok(!existsSync(join(f.root, "app/build")));
    assert.ok(existsSync(join(f.root, "app/package.json")));
    assert.ok(!after.scan.temp.some((e) => e.id === build.id), "the row is gone");
    assert.ok(after.scan.volume);
  } finally { f.done(); }
});

test("clean all temporary removes caches, build output and only the idle scratchpads", async () => {
  const f = fixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    const r = await h.call("cleanTemp");
    assert.equal(r.accepted, s.scan.temp.length);
    await h.engine.idle();
    const after = await h.call("state");
    assert.ok(after.results.every((x) => x.ok), JSON.stringify(after.results));
    assert.ok(!existsSync(join(f.home, ".gradle/caches")));
    assert.ok(!existsSync(join(f.tmpRoot, "proj/old-session")));
    assert.ok(existsSync(join(f.tmpRoot, "proj/live-session/scratchpad/f.txt")), "a session touched within the day stays");
    assert.ok(existsSync(join(f.home, ".cache/huggingface/hub/models--org--name")), "models are not temporary");
    assert.ok(existsSync(join(f.root, "lib/build/icon.png")));
    assert.equal(after.scan.temp.length, 0);
  } finally { f.done(); }
});

test("a scratchpad touched after the scan is no longer deleted", async () => {
  const f = fixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    const tmp = s.scan.temp.find((e) => e.group === "scratchpads");
    put(join(f.tmpRoot, "proj/old-session/scratchpad/new.txt"));
    await h.call("remove", { id: tmp.id });
    await h.engine.idle();
    const after = await h.call("state");
    assert.equal(after.results[0].ok, false);
    assert.match(after.results[0].error, /no longer a candidate/);
    assert.ok(existsSync(join(f.tmpRoot, "proj/old-session/scratchpad/f.txt")));
  } finally { f.done(); }
});

test("ollama: a listed tag goes through `ollama rm <name>` as one argv element", async () => {
  const f = fixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    const g = byLabel(s.scan.models, /^gemma:2b$/);
    await h.call("remove", { id: g.id });
    await h.engine.idle();
    assert.match(readFileSync(f.log, "utf8"), /^rm gemma:2b$/m);
    assert.equal((await h.call("state")).results[0].ok, true);
  } finally { f.done(); }
});

test("a size du cannot measure is UNKNOWN with its reason, never 0", async () => {
  const f = fixture();
  try {
    const badDu = join(f.bin, "du");
    writeFileSync(badDu, "#!/bin/sh\nexit 1\n");
    chmodSync(badDu, 0o755);
    const h = harness({ ...f.roots, duBin: badDu });
    const s = await h.scanned();
    const g = byLabel(s.scan.temp, /\.gradle\/caches$/);
    assert.equal(g.sizeKb, null);
    assert.match(g.sizeNote, /size unknown/);
    const slowDu = join(f.bin, "du-slow");
    writeFileSync(slowDu, "#!/bin/sh\nsleep 5\n");
    chmodSync(slowDu, 0o755);
    const h2 = harness({ ...f.roots, duBin: slowDu, duTimeoutMs: 300 });
    const s2 = await h2.scanned();
    const g2 = byLabel(s2.scan.temp, /\.gradle\/caches$/);
    assert.equal(g2.sizeKb, null);
    assert.match(g2.sizeNote, /did not finish within/);
  } finally { f.done(); }
});

test("the large-file find lists big files (show-only) and stops at its bound with a partial list", async () => {
  const f = fixture();
  try {
    put(join(f.home, "Movies/big.mov"), "");
    truncateSync(join(f.home, "Movies/big.mov"), 3 * 1024 * 1024);
    put(join(f.home, ".gradle/caches/huge.bin"), "");
    truncateSync(join(f.home, ".gradle/caches/huge.bin"), 3 * 1024 * 1024); // covered by a list: pruned
    const h = harness(f.roots);
    await h.call("scanLarge");
    await h.engine.idle();
    const s = await h.call("state");
    assert.equal(s.large.running, false);
    assert.equal(s.large.stoppedAfterS, null);
    assert.deepEqual(s.large.items.map((x) => x.path), ["~/Movies/big.mov"]);
    // a large file has no delete path at all
    await assert.rejects(() => h.call("remove", { id: join(f.home, "Movies/big.mov") }), /never a path/);

    const slowFind = join(f.bin, "find-slow");
    writeFileSync(slowFind, `#!/bin/sh\necho '${join(f.home, "Movies/big.mov")}'\nexec sleep 30\n`);
    chmodSync(slowFind, 0o755);
    // 4 s, not 2: with every core busy the sh had not printed its one line by 2 s.
    const h2 = harness({ ...f.roots, findBin: slowFind, largeLimitMs: 4000 });
    await h2.call("scanLarge");
    await h2.engine.idle();
    const s2 = await h2.call("state");
    assert.ok(s2.large.stoppedAfterS != null, "said it stopped at its bound");
    assert.equal(s2.large.items.length, 1, "what it found before the bound is kept");
  } finally { f.done(); }
});

test("ollama list parsing and sizes", () => {
  const rows = parseOllamaList("NAME   ID   SIZE   MODIFIED\nqwen3-coder:30b-64k          5d94265d163a    18 GB     2 weeks ago     \nbroken line\n");
  assert.deepEqual(rows, [{ name: "qwen3-coder:30b-64k", id: "5d94265d163a", size: "18 GB", modified: "2 weeks ago" }]);
  assert.equal(ollamaSizeKb("18 GB"), Math.round(18e9 / 1024));
  assert.equal(ollamaSizeKb("9.6 GB"), Math.round(9.6e9 / 1024));
  assert.equal(ollamaSizeKb("lots"), null);
});

// ── Linux and WSL: the profile comes in through Roots, never a real cmd.exe ──

const { safeToRemove, relMatches, driveForm, compactHow } = await import(`${D}/host/candidates.mjs`);
const { findArgs } = await import(`${D}/host/large.mjs`);
const { parsePsDrive } = await import(`${D}/host/run.mjs`);
const { parseUserProfile, detectProfile } = await import(`${D}/host/index.mjs`);

/** Set `p` and every folder up to (not including) `stop` back by `days`, leaf first. */
function aged(p, stop, days) {
  const t = (Date.now() - days * DAY) / 1000;
  for (let q = p; q.startsWith(stop) && q !== stop; q = join(q, "..")) utimesSync(q, t, t);
}

function linuxFixture() {
  const f = fixture();
  put(join(f.home, ".cache/pip/http/x"));
  put(join(f.home, ".cache/ms-playwright/chromium/x"));
  put(join(f.home, "Downloads/a.iso"));
  mkdirSync(join(f.home, "Library/Developer/CoreSimulator"), { recursive: true }); // mac-only: never listed on Linux
  return { ...f, roots: { ...f.roots, profile: "linux", tmpRoot: f.tmpRoot } };
}

function wslFixture() {
  const f = linuxFixture();
  const win = join(f.base, "mnt-c", "Users", "me");
  put(join(win, "AppData/Local/npm-cache/_cacache/x"));
  put(join(win, "AppData/Local/Google/Chrome/User Data/Default/Cache/data_0"));
  put(join(win, "AppData/Local/Mozilla/Firefox/Profiles/abc.default/cache2/entries/1"));
  put(join(win, "AppData/Local/Mozilla/Firefox/Profiles/def.work/cache2/entries/1"));
  put(join(win, "AppData/Local/Packages/CanonicalGroupLimited.Ubuntu/LocalState/ext4.vhdx"));
  put(join(win, "Downloads/setup.exe"));
  const temp = join(win, "AppData/Local/Temp");
  put(join(temp, "old-dir/a.tmp")); aged(join(temp, "old-dir/a.tmp"), temp, 10);
  put(join(temp, "old-file.log")); aged(join(temp, "old-file.log"), temp, 10);
  put(join(temp, "fresh-dir/b.tmp")); // a program wrote it today
  return { ...f, win, temp, roots: { ...f.roots, profile: "wsl", winHome: win, wslDistro: "Ubuntu", psBin: null, winTempMinAgeMs: 7 * DAY } };
}

test("linux: the XDG caches and /tmp scratchpads are listed, the Mac-only folders are not, and nothing says WSL", async () => {
  const f = linuxFixture();
  try {
    const s = (await harness(f.roots).scanned()).scan;
    assert.equal(s.profile, "linux");
    assert.ok(byLabel(s.temp, /^~\/\.cache\/pip$/), s.temp.map((e) => e.label).join(" | "));
    assert.ok(byLabel(s.temp, /^~\/\.cache\/ms-playwright$/));
    assert.ok(!byLabel(s.temp, /Library\/Caches\/pip/), "the Mac's ~/Library/Caches is not a Linux cache");
    assert.ok(byLabel(s.temp, /^~\/\.gradle\/caches$/));
    assert.ok(byLabel(s.temp, /sessions idle/), "the scratchpad row");
    assert.ok(!byLabel(s.show, /CoreSimulator/));
    assert.ok(byLabel(s.show, /^~\/Downloads$/));
    assert.ok([...s.temp, ...s.show].every((e) => e.side === undefined && !/WSL|Windows/.test(e.group)));
    assert.equal(s.wslVolume, undefined);
    assert.ok(s.volume && s.volume.label === undefined);
  } finally { f.done(); }
});

test("wsl: both sides listed and labelled, the Windows header disk and the WSL line, a Firefox row per profile", async () => {
  const f = wslFixture();
  try {
    const s = (await harness(f.roots).scanned()).scan;
    assert.equal(s.profile, "wsl");
    const pip = byLabel(s.temp, /^~\/\.cache\/pip$/);
    assert.equal(pip.side, "wsl");
    assert.equal(pip.group, "Python in WSL");
    const npm = s.temp.find((e) => e.label === join(f.win, "AppData/Local/npm-cache"));
    assert.equal(npm.side, "windows");
    assert.equal(npm.group, "npm on Windows");
    assert.ok(npm.regen);
    const ff = s.temp.filter((e) => /Firefox\/Profiles\/.*\/cache2$/.test(e.label));
    assert.equal(ff.length, 2, "one row per real profile folder");
    assert.ok(s.temp.some((e) => /Chrome\/User Data\/Default\/Cache$/.test(e.label)));
    const wt = s.temp.find((e) => e.id.startsWith("wtemp:"));
    assert.ok(wt, "the Windows temporary-files row");
    assert.match(wt.note, /^2 items/, "the old dir and the old file, never the fresh one");
    assert.equal(wt.side, "windows");
    const vhdx = s.show.find((e) => e.label.endsWith("ext4.vhdx"));
    assert.ok(vhdx, "WSL's virtual disk is shown");
    assert.match(vhdx.regen, /wsl --manage Ubuntu --set-sparse true/);
    assert.ok(s.show.some((e) => e.label === join(f.win, "Downloads") && e.side === "windows"));
    assert.ok(!s.show.some((e) => /CoreSimulator/.test(e.label)));
    assert.equal(s.volume.label, "C:", "the header is the Windows drive");
    assert.equal(s.wslVolume.label, "inside WSL");
  } finally { f.done(); }
});

test("wsl: a Linux-side delete reads free space inside WSL, a Windows-side one the Windows drive", async () => {
  const f = wslFixture();
  try {
    const h = harness(f.roots);
    const s = await h.scanned();
    const pip = byLabel(s.scan.temp, /^~\/\.cache\/pip$/);
    const npm = s.scan.temp.find((e) => e.label === join(f.win, "AppData/Local/npm-cache"));
    await h.call("remove", { id: pip.id });
    await h.call("remove", { id: npm.id });
    await h.engine.idle();
    const after = await h.call("state");
    const byId = (id) => after.results.find((r) => r.id === id);
    assert.equal(byId(pip.id).ok, true);
    assert.equal(byId(pip.id).side, "wsl");
    assert.equal(byId(npm.id).ok, true);
    assert.equal(byId(npm.id).side, "windows");
    assert.ok(!existsSync(join(f.home, ".cache/pip")));
    assert.ok(!existsSync(join(f.win, "AppData/Local/npm-cache")));
  } finally { f.done(); }
});

test("wsl: %TEMP% entries go one by one — a locked one is skipped and counted, a fresh one is kept", async () => {
  const f = wslFixture();
  const locked = () => join(f.temp, "locked-dir");
  try {
    put(join(locked(), "held.tmp"));
    aged(join(locked(), "held.tmp"), f.temp, 10);
    chmodSync(locked(), 0o555); // its file cannot be unlinked: what a program holding it open looks like to rm
    const h = harness(f.roots);
    const s = await h.scanned();
    const wt = s.scan.temp.find((e) => e.id.startsWith("wtemp:"));
    assert.match(wt.note, /^3 items/);
    await h.call("remove", { id: wt.id });
    await h.engine.idle();
    const r = (await h.call("state")).results[0];
    assert.equal(r.removed, 2);
    assert.equal(r.skipped, 1);
    assert.equal(r.side, "windows");
    assert.equal(r.ok, true);
    assert.ok(!existsSync(join(f.temp, "old-dir")) && !existsSync(join(f.temp, "old-file.log")));
    assert.ok(existsSync(join(f.temp, "fresh-dir/b.tmp")), "touched this week: kept");
    assert.ok(existsSync(join(locked(), "held.tmp")), "the held one is left alone");
  } finally { try { chmodSync(locked(), 0o755); } catch { /* gone */ } f.done(); }
});

test("wsl delete gate: a planted symlink, a `..` id, a path outside the Windows home and a Temp entry swapped after the scan all refuse", async () => {
  const f = wslFixture();
  try {
    // a symlink planted where a Firefox profile's cache2 should be
    const evil = join(f.win, "AppData/Local/Mozilla/Firefox/Profiles/zzz.evil");
    mkdirSync(evil, { recursive: true });
    symlinkSync(f.outside, join(evil, "cache2"));
    const h = harness(f.roots);
    const s = await h.scanned();
    assert.ok(!s.scan.temp.some((e) => e.label === join(evil, "cache2")), "never offered");
    assert.ok(s.scan.notes.some((n) => /zzz\.evil\/cache2: is a symlink/.test(n)), s.scan.notes.join(" | "));
    await assert.rejects(() => h.call("remove", { id: idOf("wcache", join(evil, "cache2")) }), /not a candidate of the last scan/);
    await assert.rejects(() => h.call("remove", { id: "wcache:../../outside" }), /never a path/);
    await assert.rejects(() => h.call("remove", { id: `wtemp:${f.outside}` }), /never a path/);

    // safeToRemove itself, on each shape
    const wc = { category: "wcache", label: "x" };
    assert.match(await safeToRemove(wc, f.roots, join(f.outside)), /outside/);
    assert.match(await safeToRemove(wc, f.roots, join(f.win, "AppData/Local/npm-cache/../../../..", "outside")), /outside|not a plain path/);
    assert.match(await safeToRemove(wc, f.roots, join(f.win, "AppData/Local/Packages")), /not a wcache path/);
    assert.match(await safeToRemove(wc, f.roots, join(evil, "cache2")), /symlink/);
    assert.equal(await safeToRemove(wc, f.roots, join(f.win, "AppData/Local/npm-cache")), null);
    assert.match(await safeToRemove(wc, { ...f.roots, winHome: null }, join(f.win, "AppData/Local/npm-cache")), /no delete path/);
    assert.match(await safeToRemove(wc, { ...f.roots, profile: "linux" }, join(f.win, "AppData/Local/npm-cache")), /no delete path/);
    const wt = { category: "wtemp", label: "t" };
    assert.match(await safeToRemove(wt, f.roots, join(f.temp, "old-dir/a.tmp")), /not a wtemp path/, "only entries directly under Temp");
    assert.equal(await safeToRemove(wt, f.roots, join(f.temp, "old-file.log")), null, "a file is a valid Temp entry");

    // a Temp entry swapped for a symlink to elsewhere after the scan
    const row = s.scan.temp.find((e) => e.id.startsWith("wtemp:"));
    rmSync(join(f.temp, "old-dir"), { recursive: true });
    symlinkSync(f.outside, join(f.temp, "old-dir"));
    assert.match(await safeToRemove(wt, f.roots, join(f.temp, "old-dir")), /symlink/);
    await h.call("remove", { id: row.id });
    await h.engine.idle();
    const r = (await h.call("state")).results[0];
    assert.equal(r.removed, 1, "only the old file went");
    assert.equal(readFileSync(join(f.outside, "precious.txt"), "utf8"), "keep me");
  } finally { f.done(); }
});

test("a link at AppData/Local/Temp (or at the scratchpad root) refuses every entry behind it", async () => {
  const f = wslFixture();
  try {
    const wt = { category: "wtemp", label: "t" };
    put(join(f.outside, "thesis-2019/a.txt"));
    rmSync(f.temp, { recursive: true });
    symlinkSync(f.outside, f.temp); // a Temp junctioned to another folder
    assert.match(await safeToRemove(wt, f.roots, join(f.temp, "thesis-2019")), /resolves to .* outside where it should be/);
    rmSync(join(f.win, "AppData/Local"), { recursive: true });
    symlinkSync(f.outside, join(f.win, "AppData/Local")); // …or AppData/Local itself
    assert.match(await safeToRemove(wt, f.roots, join(f.temp, "thesis-2019")), /outside where it should be|no longer there/);

    const tp = { category: "tmp", label: "s" };
    const real = join(f.tmpRoot, "proj/old-session");
    assert.equal(await safeToRemove(tp, f.roots, real), null, "a real scratchpad root passes");
    const planted = { ...f.roots, tmpRoot: join(f.base, "tmp", "claude-planted") };
    put(join(f.outside, "p/s/x.txt"));
    symlinkSync(f.outside, planted.tmpRoot);
    assert.match(await safeToRemove(tp, planted, join(planted.tmpRoot, "p/s")), /outside where it should be/);
    assert.ok(existsSync(join(f.outside, "p/s/x.txt")));
    // a real folder is not enough: it must be ours and closed to other users
    chmodSync(f.tmpRoot, 0o777);
    assert.match(await safeToRemove(tp, f.roots, real), /writable by other users/);
    chmodSync(f.tmpRoot, 0o755);
    assert.equal(await safeToRemove(tp, f.roots, real), null);
    if (process.getuid) {
      const other = { ...f.roots, tmpRoot: "/" }; // root-owned, never ours
      if (process.getuid() !== 0) assert.match(await safeToRemove({ category: "tmp", label: "s" }, other, "/x"), /outside|not a tmp path|belongs to another user/);
    }
  } finally { f.done(); }
});

test("wsl: a Temp folder with a held file inside is said to be partly cleared, not 'nothing removed'", async () => {
  const f = wslFixture();
  const held = () => join(f.temp, "_MEI1234/z_held");
  try {
    put(join(f.temp, "_MEI1234/a_data/lazy1.pyc")); put(join(f.temp, "_MEI1234/a_data/lazy2.pyc"));
    put(join(held(), "python.dll"));
    aged(join(f.temp, "_MEI1234/a_data/lazy1.pyc"), f.temp, 10); aged(join(f.temp, "_MEI1234/a_data/lazy2.pyc"), f.temp, 10);
    aged(join(held(), "python.dll"), f.temp, 10);
    chmodSync(held(), 0o555); // python.dll cannot be unlinked: a loaded DLL
    // only this folder qualifies, so the other old entries are removed first
    rmSync(join(f.temp, "old-dir"), { recursive: true }); rmSync(join(f.temp, "old-file.log"));
    const h = harness(f.roots);
    const s = await h.scanned();
    await h.call("remove", { id: s.scan.temp.find((e) => e.id.startsWith("wtemp:")).id });
    await h.engine.idle();
    const r = (await h.call("state")).results[0];
    assert.equal(r.removed, 0);
    assert.equal(r.skipped, 1);
    assert.equal(r.partial, 1);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /nothing removed/);
    assert.match(r.error, /partly cleared/);
    assert.ok(!existsSync(join(f.temp, "_MEI1234/a_data")), "what could be unlinked is gone, and the receipt says so");
    assert.ok(existsSync(join(held(), "python.dll")));
  } finally { try { chmodSync(held(), 0o755); } catch { /* gone */ } f.done(); }
});

test("wsl: build output under /mnt/<drive> is on that Windows drive, anywhere else inside WSL", () => {
  const f = wslFixture();
  try {
    const rows = buildCandidates(f.roots, { build: ["/mnt/c/dev/site/build", join(f.home, "dev/app/build")], nodeModules: [], stopped: false, outsideGit: 0 });
    assert.equal(rows[0].side, "windows");
    assert.equal(rows[0].label, "C:/dev/site/build");
    assert.match(rows[0].group, /on Windows/);
    assert.equal(rows[1].side, "wsl");
  } finally { f.done(); }
});

test("wsl large-file find: one filesystem (-xdev), /mnt and the Windows home pruned, and the result says the Windows drive was not searched", async () => {
  const f = wslFixture();
  try {
    const args = findArgs(f.roots);
    assert.ok(args.includes("-xdev"));
    assert.equal(args[0], f.home);
    assert.ok(args.includes("/mnt") && args.includes(f.win));
    assert.ok(findArgs({ ...f.roots, profile: "mac" }).includes("-xdev"));
    const h = harness(f.roots);
    await h.call("scanLarge");
    await h.engine.idle();
    assert.match((await h.call("state")).large.note, /Windows drive was not/);
  } finally { f.done(); }
});

test("wsl helpers: %USERPROFILE%, Get-PSDrive, drive form, profile detection, pattern match", async () => {
  assert.equal(parseUserProfile("C:\\Users\\me\r\n"), "C:\\Users\\me");
  assert.equal(parseUserProfile("'\\\\wsl$\\x' UNC paths are not supported.\r\nC:\\Users\\me\r\n"), "C:\\Users\\me");
  assert.equal(parseUserProfile("%USERPROFILE%\r\n"), null);
  assert.equal(parseUserProfile(""), null);
  assert.deepEqual(parsePsDrive("1000 3000\r\n"), { freeKb: Math.floor(1000 / 1024), totalKb: Math.floor(4000 / 1024) });
  assert.equal(parsePsDrive(" \r\n"), null);
  assert.equal(parsePsDrive("lots"), null);
  assert.equal(driveForm("/mnt/c/Users/me/AppData"), "C:/Users/me/AppData");
  assert.equal(driveForm("/home/me"), "/home/me");
  assert.equal(await detectProfile("darwin", {}), "mac");
  assert.equal(await detectProfile("linux", { WSL_DISTRO_NAME: "Ubuntu" }), "wsl");
  assert.ok(relMatches("a/*/c", ["a", "b", "c"]));
  assert.ok(!relMatches("a/*/c", ["a", "c"]));
  assert.ok(!relMatches("a/*/c", ["a", "b", "c", "d"]));
  assert.match(compactHow("bad name; rm"), /<distro>/, "a strange distro name is never pasted into a command");
});

// ── phases: the rows show before the code root is walked; on wsl a Windows-drive code root waits for a tap ──

const { recheckBuild, codeOnTap } = await import(`${D}/host/candidates.mjs`);
const { measureWindows, parsePsSizes, winPathOf, asciiJson, PS_SIZES } = await import(`${D}/host/run.mjs`);

/** Every state the phone would read after each push. */
function recorder(roots) {
  const seen = [];
  let engine = null;
  engine = createEngine(roots, () => { if (engine) seen.push(JSON.parse(JSON.stringify(engine.state()))); });
  return { engine, seen };
}

test("the fast part is pushed with its rows measured before the code root is walked, then the walk's rows follow", async () => {
  const f = fixture();
  try {
    const { engine, seen } = recorder(f.roots);
    engine.scan();
    await engine.idle();
    const mid = seen.find((s) => s.phase === "code" && s.scan);
    assert.ok(mid, "a push while the code root is being walked");
    assert.ok(mid.scan.temp.some((e) => e.label === "~/.gradle/caches" && e.sizeKb > 0), "the caches are already measured");
    assert.ok(!mid.scan.temp.some((e) => e.id.startsWith("build:")), "no build output yet on a first scan");
    assert.equal(mid.code.running, true);
    assert.ok(mid.code.startedAt != null);
    const end = engine.state();
    assert.equal(end.phase, null);
    assert.equal(end.code.running, false);
    assert.ok(end.scan.temp.some((e) => e.label === "~/dev/app/build"));
    assert.ok(end.scan.show.some((e) => e.id.startsWith("nm:")));
    // A second scan keeps the last walk's rows on screen until its own walk replaces them.
    seen.length = 0;
    engine.scan();
    await engine.idle();
    assert.ok(seen.find((s) => s.phase === "code" && s.scan).scan.temp.some((e) => e.label === "~/dev/app/build"));
  } finally { f.done(); }
});

test("a build row deleted while the walk runs does not come back when the walk ends", async () => {
  const f = fixture();
  try {
    // A du that waits while `slow` exists: the walk has listed the build folder, and is measuring it, when the delete runs.
    const slow = join(f.base, "slow");
    const du = join(f.bin, "slowdu");
    writeFileSync(du, `#!/bin/sh\n[ -e '${slow}' ] && sleep 1.5\nexec /usr/bin/du "$@"\n`);
    chmodSync(du, 0o755);
    const roots = { ...f.roots, duBin: du };
    const seen = [];
    let engine = null, fired = false, id = null;
    engine = createEngine(roots, () => {
      const st = JSON.parse(JSON.stringify(engine.state()));
      seen.push(st);
      if (!fired && id && st.phase === "code") { fired = true; engine.remove(id); }
    });
    engine.scan();
    await engine.idle();
    id = engine.state().scan.temp.find((e) => /app\/build$/.test(e.label))?.id;
    assert.ok(id, "the first walk lists the build row");
    writeFileSync(slow, "");
    engine.scan();
    await engine.idle();
    assert.ok(fired, "the delete ran during the second walk");
    assert.ok(!existsSync(join(f.root, "app/build")));
    const end = engine.state();
    assert.ok(!end.scan.temp.some((e) => e.id === id), "the deleted row is not brought back by the walk's list");
    assert.equal((await Promise.resolve(end.results)).find((x) => x.id === id)?.ok, true);
  } finally { f.done(); }
});

/** wsl with the code root under the Windows home (as /mnt/c/dev is on a real machine). */
function wslWinRoot() {
  const f = wslFixture();
  const root = join(f.win, "dev");
  const app = join(root, "app");
  put(join(app, "package.json"), "{}");
  put(join(app, ".gitignore"), "build/\nnode_modules/\n");
  put(join(app, "build/out.js"));
  put(join(app, "node_modules/dep/index.js"));
  put(join(app, "src/build/keep.txt")); // not next to a manifest
  execFileSync("git", ["init", "-q"], { cwd: app });
  return { ...f, root, app, roots: { ...f.roots, root } };
}

test("wsl with the code root on the Windows drive: a scan does not walk it, a tap does, and a build row from that walk deletes", async () => {
  const f = wslWinRoot();
  try {
    assert.equal(codeOnTap(f.roots), true);
    assert.equal(codeOnTap({ ...f.roots, root: join(f.home, "dev") }), false, "a Linux-side code root walks as before");
    assert.equal(codeOnTap({ ...f.roots, profile: "linux" }), false);
    const h = harness(f.roots);
    const s = await h.scanned();
    assert.equal(s.code.onTap, true);
    assert.equal(s.code.at, null, "not walked");
    assert.ok(!s.scan.temp.some((e) => e.id.startsWith("build:")));
    assert.ok(!s.scan.show.some((e) => e.id.startsWith("nm:")));
    assert.ok(s.scan.temp.some((e) => e.id.startsWith("wcache:")), "the rest of the scan is there");
    // A build id of a real build folder the host never walked is refused.
    const never = idOf("build", join(f.app, "build"));
    await assert.rejects(h.call("remove", { id: never }), /not a candidate of the last scan/);
    await h.call("scanCode");
    await h.engine.idle();
    const t = await h.call("state");
    assert.ok(t.code.at != null);
    const b = t.scan.temp.find((e) => e.id === never);
    assert.ok(b, t.scan.temp.map((e) => e.label).join(" | "));
    assert.ok(t.scan.show.some((e) => e.id.startsWith("nm:")));
    // A rescan does not walk again, and keeps the tapped walk's rows.
    const u = await h.scanned();
    assert.ok(u.scan.temp.some((e) => e.id === never));
    assert.equal(u.code.at, t.code.at);
    await h.call("remove", { id: never });
    await h.engine.idle();
    const r = (await h.call("state")).results.find((x) => x.id === never);
    assert.equal(r.ok, true, r.error);
    assert.ok(!existsSync(join(f.app, "build")));
    assert.ok(existsSync(join(f.app, "src/build/keep.txt")));
  } finally { f.done(); }
});

test("wsl code walk: node_modules PowerShell never reached are counted, and the cut does not claim to be the biggest", async () => {
  const f = wslWinRoot();
  try {
    for (let i = 0; i < 20; i++) {
      const a = join(f.root, `p${i}`);
      put(join(a, "package.json"), "{}");
      put(join(a, ".gitignore"), "node_modules/\n");
      put(join(a, "node_modules/dep/index.js"));
      execFileSync("git", ["init", "-q"], { cwd: a });
    }
    const winPath = (p) => `W:${p}`;
    // Sizes for the first three paths of every call, then the time bound runs out.
    const ps = fakePs((paths) => paths.slice(0, 3).map((_, i) => `{"i":${i},"bytes":${(i + 1) * 1024 * 1000},"bad":0,"found":1}`).join("\r\n"), { timedOut: true, code: null });
    const h = harness({ ...f.roots, psBin: "powershell.exe", psRun: ps.runPs, winPath });
    await h.scanned();
    await h.call("scanCode");
    await h.engine.idle();
    const t = await h.call("state");
    const note = t.code.notes.find((n) => /node_modules:/.test(n));
    assert.ok(note, t.code.notes.join(" | "));
    assert.match(note, /\b1[5-9] of 2\d folders are listed, but \d+ could not be measured/);
    assert.ok(!/the biggest \d+ of/.test(note) && /may not be the biggest/.test(note), "no claim of the biggest while some are unknown");
  } finally { f.done(); }
});

test("a build row whose folder became tracked since the walk is refused by the one-path recheck", async () => {
  const f = wslWinRoot();
  try {
    const h = harness(f.roots);
    await h.scanned();
    await h.call("scanCode");
    await h.engine.idle();
    const id = idOf("build", join(f.app, "build"));
    writeFileSync(join(f.app, ".gitignore"), "node_modules/\n");
    await h.call("remove", { id });
    await h.engine.idle();
    const r = (await h.call("state")).results.find((x) => x.id === id);
    assert.equal(r.ok, false);
    assert.match(r.error, /no longer a candidate/);
    assert.ok(existsSync(join(f.app, "build/out.js")));
  } finally { f.done(); }
});

test("recheckBuild: only an ignored build-named folder beside a manifest, under the root, reached the way the walk goes", async () => {
  const f = fixture();
  try {
    const ok = await recheckBuild(f.roots, join(f.root, "app/build"));
    assert.ok(ok.c && ok.c.id === idOf("build", join(f.root, "app/build")));
    const refuse = async (p, re) => { const g = await recheckBuild(f.roots, p); assert.equal(g.c, null, p); assert.match(g.why, re); };
    await refuse(join(f.root, "lib/build"), /not ignored by git/);
    await refuse(join(f.root, "plain/build"), /no package.json/);
    await refuse(join(f.root, "app/node_modules"), /not named like build output/);
    put(join(f.root, "app/node_modules/x/package.json"), "{}");
    mkdirSync(join(f.root, "app/node_modules/x/build"), { recursive: true });
    await refuse(join(f.root, "app/node_modules/x/build"), /inside node_modules/);
    await refuse(join(f.outside, "build"), /outside/);
    await refuse(`${f.root}/app/../app/build`, /outside|not a plain path/);
    await refuse("app/build", /not an absolute path/);
    symlinkSync(join(f.root, "app/build"), join(f.root, "app/.next"));
    await refuse(join(f.root, "app/.next"), /not a real folder/);
    await refuse(join(f.root, "a/b/c/d/e/f/g/h/build"), /deeper/);
  } finally { f.done(); }
});

// ── Windows-side sizes: one PowerShell call, paths on stdin, its lines read strictly ──

/** A fake powershell.exe: answers `lines(paths)` and records what it was handed. */
function fakePs(lines, extra = {}) {
  const calls = [];
  const runPs = async (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    const paths = JSON.parse(opts.input).p;
    return { code: 0, stdout: lines(paths), stderr: "", timedOut: false, ...extra };
  };
  return { runPs, calls };
}

test("powershell sizes: strict lines, a path never in the command text, a timeout leaves the rest unknown, garbage falls back to du", async () => {
  assert.equal(winPathOf("/mnt/c/Users/Jö me/x/"), "C:\\Users\\Jö me\\x");
  assert.equal(winPathOf("/mnt/d"), "D:\\");
  assert.equal(winPathOf("/home/me"), null);
  assert.equal(asciiJson({ p: ["C:\\Jö"] }), '{"p":["C:\\\\J\\u00f6"]}');
  assert.equal(JSON.parse(asciiJson({ p: ["C:\\Jö 😀"] })).p[0], "C:\\Jö 😀");
  const got = parsePsSizes('junk\r\n{"i":0,"bytes":2048,"bad":0,"found":1}\r\n{"i":1,"bytes":-5,"bad":0,"found":1}\n{"i":7,"bytes":1,"bad":0,"found":1}\n{"i":2,"bytes":"9","bad":0,"found":1}\n{"i":3,"bytes":1.5,"bad":0,"found":1}\n{"i":4', 5);
  assert.deepEqual([...got.keys()], [0], "only the one well-formed line counts");

  const paths = ["/mnt/c/Users/me/a", "/mnt/c/Users/me/b'; Remove-Item C:\\ -Recurse #", "/mnt/c/Users/me/c", "/mnt/c/Users/me/d"];
  const ok = fakePs(() => ['{"i":0,"bytes":4096,"bad":0,"found":1}', '{"i":1,"bytes":1000,"bad":3,"found":1}', '{"i":2,"bytes":0,"bad":0,"found":0}'].join("\r\n"), { timedOut: true, code: null });
  const m = await measureWindows(paths, { psBin: "powershell.exe", timeoutMs: 9000, run: ok.runPs });
  assert.equal(ok.calls.length, 1, "one call for all of them");
  assert.deepEqual(ok.calls[0].argv.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(ok.calls[0].argv[3], PS_SIZES, "the command text is fixed");
  assert.ok(!ok.calls[0].argv.some((a) => a.includes("Remove-Item")), "a path never reaches the command line");
  assert.ok(/^[\x00-\x7f]*$/.test(ok.calls[0].opts.input));
  assert.deepEqual(JSON.parse(ok.calls[0].opts.input).p[1], "C:\\Users\\me\\b'; Remove-Item C:\\ -Recurse #");
  assert.deepEqual(m.byPath.get(paths[0]), { sizeKb: 4 });
  assert.equal(m.byPath.get(paths[1]).partial, true);
  assert.equal(m.byPath.get(paths[1]).sizeKb, 1);
  assert.equal(m.byPath.get(paths[2]).sizeKb, null);
  assert.match(m.byPath.get(paths[2]).sizeNote, /did not find/);
  assert.equal(m.byPath.get(paths[3]).sizeKb, null, "not reached before the time bound: unknown, never 0");
  assert.match(m.byPath.get(paths[3]).sizeNote, /did not finish within 9 s/);

  const garbage = fakePs(() => "Get-ChildItem : something went wrong\r\n", { code: 1, error: "exit 1" });
  assert.match((await measureWindows(paths, { psBin: "powershell.exe", timeoutMs: 9000, run: garbage.runPs })).fallback, /gave no sizes/);
  assert.match((await measureWindows(paths, { psBin: null, timeoutMs: 9000 })).fallback, /not reachable/);
  assert.match((await measureWindows(["/home/me/x"], { psBin: "powershell.exe", timeoutMs: 9000, run: ok.runPs })).fallback, /no Windows path/);
});

test("wsl scan: Windows-side rows are sized by the one PowerShell call; when it fails they are du'd and say so", async () => {
  const f = wslFixture();
  try {
    const winPath = (p) => `W:${p}`;
    const ps = fakePs((paths) => paths.map((_, i) => `{"i":${i},"bytes":${(i + 1) * 1024 * 1000},"bad":0,"found":1}`).join("\r\n"));
    const s = (await harness({ ...f.roots, psBin: "powershell.exe", psRun: ps.runPs, winPath }).scanned()).scan;
    assert.equal(ps.calls.length, 1, "one call for the whole fast part");
    const handed = JSON.parse(ps.calls[0].opts.input).p;
    assert.ok(handed.every((p) => p.startsWith(`W:${f.win}`)), "only Windows-side paths");
    const npm = s.temp.find((e) => e.label === join(f.win, "AppData/Local/npm-cache"));
    assert.equal(npm.sizeKb, (handed.indexOf(`W:${npm.label}`) + 1) * 1000);
    assert.ok(!/du/.test(npm.note ?? ""));
    const pip = byLabel(s.temp, /^~\/\.cache\/pip$/);
    assert.ok(pip.sizeKb > 0 && pip.sizeKb < 1000, "the Linux side is du'd as before");

    const bad = fakePs(() => "", { code: 1, error: "exit 1" });
    const t = (await harness({ ...f.roots, psBin: "powershell.exe", psRun: bad.runPs, winPath }).scanned()).scan;
    const npm2 = t.temp.find((e) => e.label === join(f.win, "AppData/Local/npm-cache"));
    assert.ok(npm2.sizeKb > 0, "measured by du instead");
    assert.match(npm2.note, /measured with du from inside WSL \(slow\): PowerShell gave no sizes/);
    assert.match(t.temp.find((e) => e.id.startsWith("wtemp:")).note, /^2 items.*measured with du/);
    assert.ok(!/du/.test(byLabel(t.temp, /^~\/\.cache\/pip$/).note ?? ""));
  } finally { f.done(); }
});
