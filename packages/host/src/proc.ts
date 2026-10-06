/**
 * Process helpers every host module needs and used to re-declare: the promisified
 * `execFile`, a `sleep`, and a signal-0 liveness probe. Leaf-safe: imports node only.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** `promisify(execFile)` — resolves `{ stdout, stderr }`, rejects on a non-zero exit. */
export const execFileP = promisify(execFile);

/** Resolve after `ms`. `unref` lets the process exit while the timer is pending. */
export function sleep(ms: number, opts: { unref?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (opts.unref) t.unref?.();
  });
}

/** True when `pid` exists. EPERM means it exists but belongs to someone else, so it counts as alive. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
