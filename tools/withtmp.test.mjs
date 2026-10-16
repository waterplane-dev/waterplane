// scripts/with-tmp.mjs: the per-run TMPDIR that every test run is given. Pinned because its whole job is
// "nothing accumulates" (67k leftovers, 26 GB, once failed a push) and a failure of that job is silent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WRAP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "with-tmp.mjs");

function run(base, script, extra = {}) {
  return spawnSync(process.execPath, [WRAP, process.execPath, "-e", script], {
    env: { ...process.env, WP_TMP_BASE: base, WP_TMP_SWEPT: "", ...extra },
    encoding: "utf8",
  });
}
function withBase(fn) {
  const base = mkdtempSync(join(tmpdir(), "wp-withtmp-"));
  try { return fn(base); } finally {
    try { chmodSync(join(base, "x"), 0o700); } catch { /* none */ }
    rmSync(base, { recursive: true, force: true });
  }
}

test("the run's dir is gone afterwards, whatever the command left in it", () => withBase((base) => {
  const r = run(base, `const d=process.env.TMPDIR;require("fs").mkdirSync(d+"/waterplane-x-AbCdEf/a",{recursive:true});require("fs").writeFileSync(d+"/.node-1","x");process.stdout.write(d)`);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /wpt-/);
  assert.deepEqual(readdirSync(base), []);
  assert.match(r.stderr, /left in the run's temp dir/);
}));

test("a read-only tree inside the dir does not keep it alive", () => withBase((base) => {
  const r = run(base, `const fs=require("fs"),d=process.env.TMPDIR+"/ro/inner";fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+"/f","x");fs.chmodSync(d,0o555);fs.chmodSync(process.env.TMPDIR+"/ro",0o555)`);
  assert.equal(r.status, 0);
  assert.deepEqual(readdirSync(base), []);
  assert.doesNotMatch(r.stderr, /could not remove/);
}));

test("the exit code of the command is the exit code of the run, dir removed on failure too", () => withBase((base) => {
  const r = run(base, `process.exit(3)`);
  assert.equal(r.status, 3);
  assert.deepEqual(readdirSync(base), []);
}));

test("a dir of a killed wrapper is reaped; a live one, a pid-less one and a stranger's are not", () => withBase((base) => {
  const mk = (name, pid) => { mkdirSync(join(base, name)); if (pid != null) writeFileSync(join(base, name, ".pid"), String(pid)); };
  const gone = 2_000_000_000; // above any pid_max: certainly not running
  mk("wpt-dead", gone);
  mk("wpt-live", process.pid);
  mk("wpt-nopid", null);
  mk("keepme", gone);
  const r = run(base, "");
  assert.equal(r.status, 0);
  assert.deepEqual(readdirSync(base).sort(), ["keepme", "wpt-live", "wpt-nopid"]);
  assert.ok(existsSync(join(base, "keepme")));
}));
