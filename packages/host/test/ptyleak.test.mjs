/**
 * A PTY that has ended must leave NOTHING behind in this process.
 *
 * Measured 2026-09-25: the machine ran out of pseudo-terminals (511 of 511).
 * node-pty 1.1.0's macOS spawn (`pty_posix_spawn`) leaked TWO fds into the
 * parent on every spawn and closed neither: a spare `/dev/ptmx` it opened to
 * fill fds 0-2 (the cleanup loop started at the wrong index, so `low_fds[0]`
 * was never closed) and the child's SLAVE fd (only closed in the child, via
 * posix_spawn file actions). The live host held 248 masters for 67 live
 * sessions — exactly one leaked master per spawn it had ever made — and a
 * `--doctor` run that never exited held 193 more, one per 8-minute usage probe.
 * Fixed upstream in 1.2.0-beta (`close(slave)`, `i <= count`); this pins it.
 *
 * Over node-pty itself and `ownPtys()` — no daemon. When the table is ALREADY
 * full no spawn can happen and the test SKIPS saying so, because a failure
 * there would accuse this code of someone else's leak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as pty from "node-pty";
import { looksLikePtyExhaustion, ownPtys } from "../dist/ptycap.js";

const supported = process.platform === "darwin" || process.platform === "linux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn, end it the given way, await its exit. Returns false if the table is full. */
async function cycle(how) {
  let p;
  try {
    p = pty.spawn(how === "exit" ? "/bin/sh" : "/bin/sleep", how === "exit" ? ["-c", "exit 0"] : ["30"], { cols: 80, rows: 24 });
  } catch (err) {
    if (looksLikePtyExhaustion(err)) return false;
    throw err;
  }
  const exited = new Promise((r) => p.onExit(r));
  if (how === "kill") p.kill();
  const guard = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, 10_000);
  await exited;
  clearTimeout(guard);
  return true;
}

test("ownPtys answers on a supported platform, null elsewhere", () => {
  const o = ownPtys();
  if (!supported) { assert.equal(o, null); return; }
  assert.ok(o && Number.isInteger(o.masters) && Number.isInteger(o.slaves), JSON.stringify(o));
});

test("N spawned-and-ended PTYs return this process's pty fds to baseline", { skip: !supported && "no pty fd table on this platform" }, async (t) => {
  const before = ownPtys();
  for (const how of ["exit", "kill", "exit", "kill", "exit", "kill"]) {
    if (!(await cycle(how))) {
      t.skip("the system pty table is full — free some PTYs (`lsof /dev/ptmx`) and re-run");
      return;
    }
  }
  // node-pty closes the master off the socket's close, a tick or a 200 ms timer
  // after the exit — wait for it rather than assert a race.
  let after = ownPtys();
  for (let i = 0; i < 20 && after.masters > before.masters; i++) { await sleep(100); after = ownPtys(); }
  assert.equal(after.masters, before.masters, `leaked ${after.masters - before.masters} /dev/ptmx master(s) over 6 spawns`);
  assert.equal(after.slaves, before.slaves, `leaked ${after.slaves - before.slaves} slave fd(s) over 6 spawns`);
});

test("a live PTY is counted while it runs (the gauge sees what it should)", { skip: !supported && "no pty fd table on this platform" }, async (t) => {
  const before = ownPtys();
  let p;
  try { p = pty.spawn("/bin/sleep", ["30"], { cols: 80, rows: 24 }); } catch (err) {
    if (looksLikePtyExhaustion(err)) { t.skip("the system pty table is full"); return; }
    throw err;
  }
  try {
    const during = ownPtys();
    assert.equal(during.masters, before.masters + 1, "one master per live PTY, no more");
    assert.equal(during.slaves, before.slaves, "the parent holds no slave fd");
  } finally {
    const exited = new Promise((r) => p.onExit(r));
    p.kill();
    await exited;
  }
});

test("the newer node-pty exhaustion wording is still recognised", () => {
  assert.equal(looksLikePtyExhaustion(new Error("posix_openpt failed: Device not configured")), true);
});
