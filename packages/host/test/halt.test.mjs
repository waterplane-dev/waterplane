/**
 * The emergency halt (`halt.ts`, `shared/halt.ts`).
 *
 * Pinned rather than described, because each fails silently:
 *  1. **The latch survives a restart, and a torn file reads as HALTED.** The
 *     person asked for everything to stop; a corrupt write must not be what
 *     starts it again. Absent (never halted) is off.
 *  2. **The kill reaches the whole tree and forces what ignores SIGTERM.** A
 *     `claude` is a shell away from the tools it runs; killing only the pane's
 *     process leaves a `npm test` running.
 *  3. **A pid is ours only with its start time.** The tree walk never climbs
 *     to init or to this process.
 *  4. **A halted headless run never starts**, and answers in the failure shape
 *     every caller already reads.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "wp-halt-root-"));
const state = mkdtempSync(join(tmpdir(), "wp-halt-state-"));
process.env.WATERPLANE_ROOT = root;
process.env.WATERPLANE_STATE_DIR = state;
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); });

const fresh = (n) => import(`../dist/halt.js?v=${n}`);
const { hostStateDir } = await import("../dist/branddirs.js");
const latchFile = () => join(hostStateDir(root), "halt.json");

test("never halted: no file, latch off", async () => {
  const h = await fresh(1);
  assert.equal(existsSync(latchFile()), false);
  assert.equal(h.isHalted(), false);
});

test("the latch is persisted and read back by a fresh process", async () => {
  const h = await fresh(2);
  h.setHalted(true, { at: 1, sessions: 2, processes: 5, forced: 1, sidecars: 0, held: 3 });
  assert.equal(JSON.parse(readFileSync(latchFile(), "utf8")).on, true);
  const again = await fresh(3);
  assert.equal(again.isHalted(), true);
  assert.equal(again.haltState().receipt.sessions, 2);
  again.setHalted(false);
  const lifted = await fresh(4);
  assert.equal(lifted.isHalted(), false);
  assert.equal(lifted.haltState().since, null);
  assert.equal(lifted.haltState().receipt.held, 3, "the last receipt outlives the lift");
});

test("a present but unreadable latch file reads as halted", async () => {
  writeFileSync(latchFile(), "{ torn");
  const h = await fresh(5);
  assert.equal(h.isHalted(), true);
  h.setHalted(false);
});

test("treeOf: descendants only, never pid 1 or this process", async () => {
  const { treeOf } = await fresh(6);
  const procs = [
    { pid: 1, ppid: 0, start: "a" }, { pid: 10, ppid: 1, start: "b" },
    { pid: 11, ppid: 10, start: "c" }, { pid: 12, ppid: 11, start: "d" },
    { pid: 20, ppid: 1, start: "e" }, { pid: process.pid, ppid: 11, start: "f" },
  ];
  assert.deepEqual(treeOf([10], procs).map((p) => p.pid).sort(), [10, 11, 12]);
  assert.deepEqual(treeOf([1], procs), []);
  assert.deepEqual(treeOf([999], procs), [], "an unknown root is nothing");
});

test("killTrees: SIGTERM the tree, SIGKILL whatever ignored it", async () => {
  const { killTrees } = await fresh(7);
  // A parent that ignores TERM, with a child that does not.
  const sh = spawn("sh", ["-c", "trap '' TERM; sleep 30 & wait"], { stdio: "ignore" });
  const exited = new Promise((r) => sh.on("exit", (code, sig) => r(sig)));
  after(() => { try { sh.kill("SIGKILL"); } catch { /* gone */ } });
  await new Promise((r) => setTimeout(r, 200)); // let the child appear
  const r = await killTrees([sh.pid], 300);
  assert.ok(r.processes >= 2, `the child is in the tree (${r.processes})`);
  assert.ok(r.forced >= 1, "the TERM-ignoring parent was forced");
  assert.equal(await exited, "SIGKILL");
});

test("halted: a headless run never starts and reads as failed", async () => {
  // The sidecar reads the UN-versioned module, which nothing above loaded:
  // its first read of the latch is the file written here.
  writeFileSync(latchFile(), JSON.stringify({ on: true, since: 1, receipt: null }));
  const { runHeadlessClaude } = await import("../dist/sidecar/sidecarclaude.js");
  const h = await import("../dist/halt.js");
  try {
    assert.equal(h.isHalted(), true);
    const run = await runHeadlessClaude({ args: ["-p"], prompt: "x", cwd: root, timeoutMs: 1000, maxBuffer: 1024 });
    assert.equal(run.failed, true);
    assert.match(run.stderr, /halted/);
  } finally { h.setHalted(false); }
});
