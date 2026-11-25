/**
 * A write(2) may take part of a buffer and say so in its count (a full disk does, with the error only on the
 * next call). Three host files went through a bare `writeSync` that ignored the count: a certificate, the update
 * lock and the wire recording. `node:fs` is replaced in a CHILD, before the module under test is loaded, so
 * the real code runs against a disk that writes short, stops half way, or takes nothing. (R-reliability-017)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAll } from "../dist/writeall.js";

const dist = (f) => fileURLToPath(new URL(`../dist/${f}`, import.meta.url));
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "waterplane-shortwrite-")));

/** `disk`: "short" = one byte a call; "full" = `room` bytes, then ENOSPC; "none" = every call takes 0. Only writes to a path with `only` in it are touched. */
const FAKE = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = { open: fs.openSync, write: fs.writeSync };
const seen = new Map();
fs.openSync = (p, ...a) => { const fd = real.open(p, ...a); seen.set(fd, String(p)); return fd; };
// "pid" = all of one process id and half of another, whatever its length here.
const digits = String(process.pid).length;
let room = process.env.ROOM === "pid" ? digits + Math.floor(digits / 2) : Number(process.env.ROOM ?? 0);
fs.writeSync = (fd, b, off = 0, len, pos) => {
  if (!(seen.get(fd) ?? "").includes(process.env.ONLY)) return real.write(fd, b, off, len, pos);
  const buf = typeof b === "string" ? Buffer.from(b) : b;
  const want = typeof b === "string" ? buf.length : (len ?? buf.length - off);
  const at = typeof b === "string" ? 0 : off;
  if (process.env.DISK === "none") return 0;
  if (process.env.DISK === "short") return real.write(fd, buf, at, Math.min(1, want));
  if (room <= 0) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const n = Math.min(room, want); room -= n;
  return real.write(fd, buf, at, n);
};
syncBuiltinESMExports();
`;

function child(body, env) {
  const home = scratch();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", FAKE + body], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), WATERPLANE_ROOT: home, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// ── the helper ──────────────────────────────────────────────────────────────

test("writeAll: a short write is continued, one that takes nothing throws, an error passes through", () => {
  const out = [];
  const some = (n) => (_fd, buf, off, len) => { const k = Math.min(n, len); out.push(...buf.subarray(off, off + k)); return k; };
  writeAll(1, "grün 12345", some(3));
  assert.equal(Buffer.from(out).toString("utf8"), "grün 12345");
  out.length = 0;
  writeAll(1, new Uint8Array([1, 2, 3]), some(2));
  assert.deepEqual(out, [1, 2, 3]);
  writeAll(1, "", () => assert.fail("nothing to write"));
  for (const bad of [0, -1, NaN, undefined]) assert.throws(() => writeAll(1, "abc", () => bad), /of 3 bytes/);
  assert.throws(() => writeAll(1, "abc", () => { throw Object.assign(new Error("x"), { code: "ENOSPC" }); }), { code: "ENOSPC" });
});

test("no host file writes to a descriptor around the helper", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const bare = readdirSync(src, { recursive: true }).map(String)
    .filter((f) => f.endsWith(".ts") && f !== "writeall.ts")
    .filter((f) => /\b(writeSync|writevSync)\b/.test(readFileSync(join(src, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  assert.deepEqual(bare, [], "use writeAll (src/writeall.ts): a short write is not an error");
});

// ── the certificate ─────────────────────────────────────────────────────────

const ISSUE = `
const { run } = await import(${JSON.stringify(dist("cli/lancert.js"))});
const { ensureSelfSigned } = await import(${JSON.stringify(dist("lantls.js"))});
const root = process.env.CERT_ROOT, out = process.env.CERT_OUT;
ensureSelfSigned(root, ["192.168.1.20"], ["mac.local"]);
const deps = { root, ips: ["192.168.1.20"], restart: "RESTART", ask: null };
if (process.env.FIRST) { process.env.ONLY_WAS = process.env.ONLY; process.env.ONLY = "nothing-matches"; await run(["issue", "--name", "desk.home.arpa", "--out", out], deps); process.env.ONLY = process.env.ONLY_WAS; }
console.log("CODE", await run(["issue", "--name", "desk.home.arpa", "--out", out, "--yes"], deps));
`;
const cert = (disk, extra = {}) => {
  const root = scratch(), out = scratch();
  const r = child(ISSUE, { CERT_ROOT: root, CERT_OUT: out, DISK: disk, ONLY: "ca.cer", ...extra });
  return { out, text: r.stdout + r.stderr, code: /CODE (\d)/.exec(r.stdout)?.[1] };
};

test("lan-cert: a short write still leaves the whole certificate", () => {
  const r = cert("short");
  assert.equal(r.code, "0", r.text);
  // A DER SEQUENCE says its own length: 30 82 <hi> <lo>.
  const der = readFileSync(join(r.out, "ca.cer"));
  assert.equal(der.length, 4 + der.readUInt16BE(2));
});

test("lan-cert: a disk that fills half way leaves no certificate and no temp file, and says it failed", () => {
  for (const disk of ["full", "none"]) {
    const r = cert(disk, { ROOM: "100" });
    assert.equal(r.code, "1", r.text);
    assert.match(r.text, /could not be written .*Nothing was changed/);
    assert.deepEqual(readdirSync(r.out), [], disk);
  }
});

test("lan-cert: over an older certificate, a disk that fills leaves the older one whole", () => {
  const r = cert("full", { ROOM: "100", FIRST: "1" });
  assert.equal(r.code, "1", r.text);
  assert.deepEqual(readdirSync(r.out), ["ca.cer"]);
  const der = readFileSync(join(r.out, "ca.cer"));
  assert.equal(der.length, 4 + der.readUInt16BE(2));
});

// ── the update lock ─────────────────────────────────────────────────────────

const TAKE = `
const { takeLock } = await import(${JSON.stringify(dist("cli/selfupdate.js"))});
const got = takeLock(process.env.DATA);
console.log(typeof got === "string" ? "REFUSED " + got : "TOOK " + fs.readFileSync(process.env.DATA + "/versions/.update.lock", "utf8") + " " + process.pid);
if (process.env.RELEASE && typeof got !== "string") got();
`;
const data = () => { const d = scratch(); mkdirSync(join(d, "versions")); return d; };
const lockOf = (d) => join(d, "versions", ".update.lock");
const take = (d, env = {}) => child(TAKE, { DATA: d, ONLY: "update.lock", DISK: "short", ...env }).stdout.trim();

test("update lock: a short write still leaves a full pid, and releasing it leaves nothing", () => {
  const d = data();
  const [, pid, own] = /^TOOK (\d+) (\d+)$/.exec(take(d, { RELEASE: "1" })) ?? [];
  assert.ok(own && pid === own, `${pid} ${own}`);
  assert.deepEqual(readdirSync(join(d, "versions")), []);
});

test("update lock: a disk that takes nothing, or a byte, leaves no lock at all and no update", () => {
  for (const [disk, ROOM] of [["none", "0"], ["full", "1"], ["full", "0"]]) {
    const d = data();
    assert.match(take(d, { DISK: disk, ROOM }), /^REFUSED could not take/);
    assert.deepEqual(readdirSync(join(d, "versions")), [], disk);
  }
});

test("update lock: one being written (empty) is another update, not a dead one; left for a minute it is stale", () => {
  const d = data();
  writeFileSync(lockOf(d), "");
  assert.match(take(d), /^REFUSED another update is starting/);
  assert.equal(readFileSync(lockOf(d), "utf8"), "", "left as it was");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockOf(d), old, old);
  assert.match(take(d), /^TOOK/);
});

test("update lock: a living holder refuses, a dead one is taken over, and only its own lock is released", () => {
  const d = data();
  writeFileSync(lockOf(d), String(process.pid));
  assert.equal(take(d), `REFUSED another update is running (pid ${process.pid}).`);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(lockOf(d), String(dead));
  assert.match(take(d), /^TOOK/);
  assert.deepEqual(readdirSync(join(d, "versions")), [".update.lock"], "no temp file is left");

  // Released after somebody else took it (its holder was judged dead): the other's lock stays.
  const e = data();
  child(`${TAKE}
    fs.rmSync(process.env.DATA + "/versions/.update.lock");
    fs.writeFileSync(process.env.DATA + "/versions/.update.lock", "${process.pid}");
    got();`, { DATA: e, ONLY: "nothing-matches" });
  assert.equal(readFileSync(lockOf(e), "utf8"), String(process.pid));
});

test("update lock: two updaters that both saw a dead holder do not both take it", () => {
  const d = data();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(lockOf(d), String(dead));
  // Between this one's reading of the dead pid and its takeover, another updater takes the lock over.
  const out = child(`
    let once = true;
    const kill = process.kill.bind(process);
    process.kill = (pid, sig) => { if (pid === ${dead} && once) { once = false; fs.rmSync(process.env.DATA + "/versions/.update.lock"); fs.writeFileSync(process.env.DATA + "/versions/.update.lock", "${process.pid}"); } return kill(pid, sig); };
    ${TAKE}`, { DATA: d, ONLY: "nothing-matches" }).stdout.trim();
  assert.equal(out, `REFUSED another update is running (pid ${process.pid}).`);
  assert.equal(readFileSync(lockOf(d), "utf8"), String(process.pid), "the other updater still holds it");
});

test("update lock: released while another updater has it moved aside, it is not put back as held", () => {
  for (const noLink of ["", `fs.linkSync = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }; syncBuiltinESMExports();`]) {
    const d = data();
    // The holder is this very process: a second updater reads it as dead, moves the lock aside, reads it as alive, and
    // the holder releases before that answer comes back.
    const out = child(`${noLink}
      const { takeLock } = await import(${JSON.stringify(dist("cli/selfupdate.js"))});
      const first = takeLock(process.env.DATA);
      let asked = 0;
      process.kill = () => { if (++asked === 1) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); first(); return true; };
      const second = takeLock(process.env.DATA);
      first();
      console.log(typeof first, asked, second);`, { DATA: d, ONLY: "nothing-matches" }).stdout.trim();
    assert.match(out, /^function 2 another update is running/);
    assert.deepEqual(readdirSync(join(d, "versions")), [".update.lock"]);
    assert.equal(readFileSync(lockOf(d), "utf8"), "", "it names nobody: the holder has let go");
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(lockOf(d), old, old);
    assert.match(take(d, { RELEASE: "1" }), /^TOOK/, "and a minute later an update starts");
    assert.deepEqual(readdirSync(join(d, "versions")), []);
  }
});

test("update lock: a living lock moved aside is put back for its holder, never over one taken meanwhile", () => {
  for (const meanwhile of ["", "2147483647"]) {
    const d = data();
    writeFileSync(lockOf(d), String(process.pid));
    const out = child(`
      let asked = 0;
      process.kill = () => {
        if (++asked === 1) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        if (${JSON.stringify(meanwhile)}) fs.writeFileSync(process.env.DATA + "/versions/.update.lock", ${JSON.stringify(meanwhile)});
        return true;
      };
      ${TAKE}`, { DATA: d, ONLY: "nothing-matches" }).stdout.trim();
    assert.match(out, /^REFUSED another update is running/);
    assert.equal(readFileSync(lockOf(d), "utf8"), meanwhile || String(process.pid));
    assert.deepEqual(readdirSync(join(d, "versions")), [".update.lock"]);
  }
});

test("update lock: a filesystem without hard links still locks, and still never by an empty file", () => {
  const noLink = `fs.linkSync = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }; syncBuiltinESMExports();`;
  const on = (d, env = {}) => child(noLink + TAKE, { DATA: d, ONLY: "update.lock", DISK: "short", ...env }).stdout.trim();
  const d = data();
  assert.match(on(d), /^TOOK (\d+) \1$/);
  const e = data();
  assert.match(on(e, { DISK: "full", ROOM: "pid" }), /^REFUSED could not take/);
  assert.deepEqual(readdirSync(join(e, "versions")), []);
});

// ── the recording ───────────────────────────────────────────────────────────

const RECORD = `
const w = await import(${JSON.stringify(dist("wirerecord.js"))});
for (let i = 0; i < 4; i++) w.recordWireFrame("out", { t: "m" + i, pad: "x".repeat(40) });
`;
const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).msg.t);

test("wire recording: short writes keep every line whole", () => {
  const f = join(scratch(), "wire.jsonl");
  child(RECORD, { WATERPLANE_WIRE_RECORD: f, ONLY: "wire.jsonl", DISK: "short" });
  assert.deepEqual(lines(f), ["m0", "m1", "m2", "m3"]);
});

test("wire recording: a line the disk does not take whole is taken back out, and the recording stops and says so", () => {
  const f = join(scratch(), "wire.jsonl");
  const r = child(RECORD, { WATERPLANE_WIRE_RECORD: f, ONLY: "wire.jsonl", DISK: "full", ROOM: "150" });
  assert.deepEqual(lines(f), ["m0"], "whole lines only, nothing after the one that failed");
  assert.match(r.stderr, /wire recording stopped: .*ENOSPC/);
});

test("wire recording: lines another host appended meanwhile are not cut with the torn one", () => {
  const f = join(scratch(), "wire.jsonl");
  child(`
    const w = await import(${JSON.stringify(dist("wirerecord.js"))});
    const pad = "x".repeat(60);
    w.recordWireFrame("out", { t: "m0", pad });
    fs.appendFileSync(${JSON.stringify(f)}, '{"msg":{"t":"theirs"}}\\n');
    w.recordWireFrame("out", { t: "m1", pad });`,
  { WATERPLANE_WIRE_RECORD: f, ONLY: "wire.jsonl", DISK: "full", ROOM: "150" });
  assert.deepEqual(lines(f), ["m0", "theirs"]);
});

// The first ONE write to the file takes 20 bytes; what `during` does happens before the rest of it fails.
const torn = (f, during) => child(`
  const was = { open: fs.openSync, write: fs.writeSync };
  let fd = -1, n = 0;
  fs.openSync = (p, ...a) => { const x = was.open(p, ...a); if (String(p) === ${JSON.stringify(f)}) fd = x; return x; };
  const theirs = (t) => fs.appendFileSync(${JSON.stringify(f)}, JSON.stringify({ msg: { t } }) + "\\n");
  fs.writeSync = (x, b, off, len, pos) => {
    if (x !== fd) return was.write(x, b, off, len, pos);
    const at = n++;
    if (at === 1) { ${during.before ?? ""}; return was.write(x, b, off, 20, pos); }
    if (at === 2) { ${during.after ?? ""}; throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); }
    return was.write(x, b, off, len, pos);
  };
  syncBuiltinESMExports();
  ${RECORD}`, { WATERPLANE_WIRE_RECORD: f, ONLY: "nothing-matches" });

test("wire recording: a line another host appends just before the one that tears is not cut", () => {
  const f = join(scratch(), "wire.jsonl");
  const r = torn(f, { before: `theirs("theirs")` });
  assert.deepEqual(lines(f), ["m0", "theirs"]);
  assert.doesNotMatch(r.stderr, /still in the file/);
});

test("wire recording: with another host's line behind it the torn one stays, and is said to", () => {
  const f = join(scratch(), "wire.jsonl");
  const r = torn(f, { after: `theirs("theirs")` });
  const text = readFileSync(f, "utf8");
  assert.ok(text.endsWith('{"msg":{"t":"theirs"}}\n'), "theirs is whole");
  assert.match(r.stderr, /wire recording stopped: .*ENOSPC.*still in the file/);
});
