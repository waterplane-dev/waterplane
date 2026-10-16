// The e2e runner's port lock (`scripts/lib-portlock.mjs`): one run holds a
// port, and a dead run's lock is taken over by exactly ONE of the runs waiting
// for it. Two holders is one suite SIGKILLing the other's live host — the
// failure the lock exists to stop, reading as a flaky feature
// (docs/notes/testing-and-ops.md).
//
// The interleavings are forced in one process through the lib's hooks, so the
// race is a fact of every run rather than a matter of luck; the last test then
// has real processes take over in the same instant, over and over.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { portLocks } from "../scripts/lib-portlock.mjs";

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "lib-portlock.mjs");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), "portlock-")); dirs.push(d); return d; };

const PORT = 8813;
const DEAD = 999_001;
/** Pretend runs in one process: each has its own pid, alive while in `live`. */
function runs(dir, live, extra = {}) {
  const isAlive = (p) => live.has(p);
  return (pid, hooks = {}) => { live.add(pid); return portLocks({ dir, pid, isAlive, hooks, ...extra }); };
}
const ownerOf = (dir) => Number(readFileSync(join(dir, `${PORT}.lock`), "utf8"));
const seedStale = (dir) => writeFileSync(join(dir, `${PORT}.lock`), String(DEAD));

test("a free port is taken, a held one is waited for and named, and a release frees it", () => {
  const dir = freshDir();
  const mk = runs(dir, new Set());
  const a = mk(1001), b = mk(1002);
  assert.deepEqual(a.tryAcquire(PORT), { held: true });
  assert.deepEqual(b.tryAcquire(PORT), { held: false, owner: 1001 });
  b.release(PORT); // not b's — must leave a's lock alone
  assert.equal(ownerOf(dir), 1001);
  a.release(PORT);
  assert.deepEqual(b.tryAcquire(PORT), { held: true });
  assert.equal(ownerOf(dir), 1002);
});

test("a dead run's lock is taken over", () => {
  const dir = freshDir();
  seedStale(dir);
  const a = runs(dir, new Set())(1001);
  assert.deepEqual(a.tryAcquire(PORT), { held: true });
  assert.equal(ownerOf(dir), 1001);
});

test("two runs taking over one stale lock in the same instant: exactly one holds it", () => {
  // The race the first version lost: A reads the dead pid, B takes over
  // completely, and A — acting on what it read — must not remove B's live lock.
  const dir = freshDir();
  seedStale(dir);
  const mk = runs(dir, new Set());
  const b = mk(1002);
  let bGot = null;
  const a = mk(1001, { judged: () => { bGot = b.tryAcquire(PORT); } });
  const aGot = a.tryAcquire(PORT);
  assert.deepEqual(bGot, { held: true }, "the run that got there first holds it");
  assert.deepEqual(aGot, { held: false, owner: 1002 }, "…and the other one waits for it, naming it");
  assert.equal(ownerOf(dir), 1002, "the lock on disk is still the winner's");
  assert.ok(!existsSync(join(dir, `${PORT}.takeover`)), "…and the takeover mutex is given back");
});

test("a run that finds a takeover in progress waits for it rather than doing a second one", () => {
  const dir = freshDir();
  seedStale(dir);
  const mk = runs(dir, new Set());
  const b = mk(1002);
  let bGot = null;
  const a = mk(1001, { mutex: () => { bGot = b.tryAcquire(PORT); } });
  assert.deepEqual(a.tryAcquire(PORT), { held: true });
  assert.deepEqual(bGot, { held: false, owner: 0 }, "B saw the takeover mutex and backed off");
  assert.equal(ownerOf(dir), 1001);
  assert.deepEqual(b.tryAcquire(PORT), { held: false, owner: 1001 }, "…and then waits on A like on any live run");
});

test("a run that died inside the takeover mutex does not wedge the port for ever", () => {
  const dir = freshDir();
  seedStale(dir);
  const mutex = join(dir, `${PORT}.takeover`);
  mkdirSync(mutex);
  const mk = runs(dir, new Set(), { staleMutexMs: 60_000 });
  const a = mk(1001);
  assert.deepEqual(a.tryAcquire(PORT), { held: false, owner: 0 }, "a fresh mutex is somebody's takeover — wait");
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(mutex, old, old);
  a.tryAcquire(PORT); // clears the abandoned mutex…
  assert.deepEqual(a.tryAcquire(PORT), { held: true }, "…and the next look takes the port");
});

test("real processes taking over a dead run's lock at once never hold it two at a time", async () => {
  // Each child takes the lock, proves it is alone in the critical section by
  // creating `inside` exclusively, and then EXITS WITHOUT RELEASING — so every
  // hand-over below is a dead run's lock that all the others, polling, see go
  // stale in the same instant. The first version failed this within a round.
  const N = 8;
  const ROUNDS = 3;
  for (let round = 0; round < ROUNDS; round++) {
    const dir = freshDir();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid; // a pid that is surely gone
    writeFileSync(join(dir, `${PORT}.lock`), String(dead));
    const start = Date.now() + 400;
    const child = `
      import { openSync, closeSync, unlinkSync, appendFileSync } from "node:fs";
      import { join } from "node:path";
      import { portLocks } from ${JSON.stringify(pathToFileURL(LIB).href)};
      const dir = ${JSON.stringify(dir)};
      const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
      const locks = portLocks({ dir, isAlive: alive });
      while (Date.now() < ${start}) { /* every child starts in the same instant */ }
      for (;;) {
        if (locks.tryAcquire(${PORT}).held) break;
        await new Promise((r) => setTimeout(r, 1));
      }
      try { closeSync(openSync(join(dir, "inside"), "wx")); }
      catch { appendFileSync(join(dir, "violations"), process.pid + "\\n"); process.exit(0); }
      await new Promise((r) => setTimeout(r, 15));
      unlinkSync(join(dir, "inside"));
      appendFileSync(join(dir, "held"), process.pid + "\\n");
      process.exit(0); // never released: the next holder takes over a DEAD lock
    `;
    const kids = Array.from({ length: N }, () => spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: ["ignore", "ignore", "pipe"] }));
    const errs = [];
    await Promise.all(kids.map((k) => new Promise((resolve) => {
      k.stderr.on("data", (d) => errs.push(String(d)));
      k.on("close", resolve);
    })));
    assert.equal(errs.join(""), "", "no child crashed");
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean) : []);
    assert.deepEqual(read("violations"), [], `round ${round}: two runs held the port at once`);
    assert.equal(read("held").length, N, `round ${round}: every run got the port in turn`);
  }
});
