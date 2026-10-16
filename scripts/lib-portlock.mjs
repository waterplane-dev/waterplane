// The e2e runner's per-port ownership (`run-e2e.mjs`): exactly one run on this
// machine may hold a port, and a dead run's lock is taken over by exactly one.
//
// Why there is a lock at all is in `run-e2e.mjs` (`acquirePorts`) and
// docs/notes/testing-and-ops.md. This file is the HOW, kept apart so the races
// can be pinned without booting anything (`tools/portlock.test.mjs`).
//
// The first version was `writeFileSync(lock, pid, { flag: "wx" })`, and a lock
// whose pid was no longer a run was `unlink`ed and retried. That had two races,
// both of which leave TWO runs holding one port — i.e. one suite SIGKILLing the
// other's live host, the very failure the lock exists to stop:
//
//   1. **The takeover.** Runs A and B both read the stale pid. A unlinks it and
//      creates its own lock. B — still acting on what it read — unlinks A's
//      LIVE lock ("raced to it", said the comment), creates its own, and both
//      hold the port. An `unlink` cannot say "only if it is still the file I
//      looked at"; nothing in POSIX can.
//   2. **The empty file.** `wx` is open(O_CREAT|O_EXCL) and THEN a write. A
//      reader landing between the two reads "", which parsed as no owner, which
//      was stale — and it unlinked a lock that had existed for a microsecond.
//
// So:
//
//   • A lock is CREATED only by `link(tmp, lock)`: the pid is in the temp file
//     before the name exists, so nobody can ever read a lock without its owner,
//     and `link` refuses an existing name exactly as `wx` did.
//   • A stale lock is REMOVED only under the port's takeover mutex — an
//     exclusive `mkdir` — and only after its owner is read again UNDER that
//     mutex. Nothing but a mutex holder ever removes another run's lock, and a
//     live owner's lock cannot replace a dead one's except through a mutex
//     holder, so the file the re-read judged is the file the unlink removes.
//     Two runs taking over in the same instant: one gets the mutex; the other
//     gets EEXIST and waits; by the time it holds the mutex, the lock it reads
//     is the winner's, alive, and it waits for that like any other.
//   • After the unlink, the mutex holder creates its lock with `link` like
//     anybody else. A newcomer that saw the name absent may beat it to it — the
//     newcomer then holds, the mutex holder does not, and that is still one.
//
// The one residue: a run that dies INSIDE the mutex (a few synchronous
// milliseconds) leaves the mutex dir behind. One older than `staleMutexMs` is
// removed so nothing wedges; two runs doing that recovery in the same instant
// after such a death could both get through it. That needs a kill -9 landing in
// that window first, and is said here rather than hidden.
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Is `pid` a live run of the e2e runner? A reused pid that is something else is
 * not. When the answer cannot be had — `ps` failing to spawn on a machine out of
 * processes, which is exactly a loaded one — it is "alive": a wrong "dead" here
 * is a live host SIGKILLed, a wrong "alive" is a wait that the next look ends.
 */
export function isRunnerAlive(pid) {
  try { process.kill(pid, 0); } catch (e) {
    if (e?.code === "ESRCH") return false; // gone
    if (e?.code === "EPERM") return false; // another user's process: not a run of ours
  }
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return cmd.includes("run-e2e");
  } catch (e) {
    // `ps -p` exits 1 when there is no such process; anything else is not knowing.
    return e?.status !== 1;
  }
}

/**
 * The port locks under `dir`, for one owner.
 *
 * `pid` and `isAlive` are parameters so the races can be pinned in one process
 * with several pretend runs; `hooks` are called at the two moments a second run
 * can interleave (`judged`: the first read said stale, nothing taken yet;
 * `mutex`: inside the takeover mutex, before the unlink) — test seams only.
 */
export function portLocks({ dir, pid = process.pid, isAlive = isRunnerAlive, staleMutexMs = 60_000, hooks = {} }) {
  const lockPath = (port) => join(dir, `${port}.lock`);
  const mutexPath = (port) => join(dir, `${port}.takeover`);
  let seq = 0;

  /** The pid in a lock file, 0 when there is no lock. Never "" — see `create`. */
  const readOwner = (port) => {
    try { return Number(readFileSync(lockPath(port), "utf8").trim()) || 0; } catch { return 0; }
  };

  /** Create the lock with our pid already in it. true = it is ours. */
  const create = (port) => {
    const tmp = join(dir, `.${port}.${pid}.${++seq}.tmp`);
    writeFileSync(tmp, String(pid));
    try {
      linkSync(tmp, lockPath(port));
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      return false;
    } finally {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  };

  /** Take the takeover mutex, or say who is in the way. */
  const takeMutex = (port) => {
    try { mkdirSync(mutexPath(port)); return true; } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    // A run that died inside the mutex must not wedge the port for ever.
    try {
      if (Date.now() - statSync(mutexPath(port)).mtimeMs > staleMutexMs) rmdirSync(mutexPath(port));
    } catch { /* someone else recovered it, or it was released meanwhile */ }
    return false;
  };
  const dropMutex = (port) => { try { rmdirSync(mutexPath(port)); } catch { /* gone */ } };

  /**
   * One attempt, never waiting: `{ held: true }`, or `{ held: false, owner }`
   * with the live run in the way (`owner` 0 = a takeover is in progress, or the
   * lock changed hands under us — try again shortly).
   */
  function tryAcquire(port) {
    mkdirSync(dir, { recursive: true });
    if (create(port)) return { held: true };
    const owner = readOwner(port);
    if (owner === pid) return { held: true };
    if (owner && isAlive(owner)) return { held: false, owner };
    // Stale (its run is gone) — or it vanished between the two reads.
    hooks.judged?.(port);
    if (!takeMutex(port)) return { held: false, owner: 0 };
    try {
      hooks.mutex?.(port);
      const again = readOwner(port);
      if (again === pid) return { held: true };
      if (again && isAlive(again)) return { held: false, owner: again };
      if (again) { try { unlinkSync(lockPath(port)); } catch { /* gone */ } }
      return create(port) ? { held: true } : { held: false, owner: readOwner(port) };
    } finally {
      dropMutex(port);
    }
  }

  /** Give a port back — only if the lock is still ours. Nothing can replace a
   *  live owner's lock, so the read and the unlink see the same file. */
  function release(port) {
    if (readOwner(port) === pid) { try { unlinkSync(lockPath(port)); } catch { /* gone */ } }
  }

  return { tryAcquire, release, lockPath };
}
