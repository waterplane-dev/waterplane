/**
 * The delivery ladder's clock — the one place it reads wall time.
 *
 * Every deadline, hold window and poll cadence in `deliver.ts` and `deliver/*`
 * goes through a `Clock`, so a test can hand in virtual time
 * (`packages/host/test/lib/fakeclock.mjs`) and a 53 s ordering case runs in
 * microseconds. The default is `realClock`: same `Date.now()`, same timer.
 * `tools/deliverclock.test.mjs` refuses a bare `Date.now()`/`sleep(`/`setTimeout(`
 * in `deliver.ts`, `deliver/`, `server/deliveries.ts`, `settle.ts`'s waits and
 * `sessions/drive.ts`'s `waitReady` — the whole path from `startPrompt` /
 * `deliverChain` to the last proof.
 */
import { sleep } from "./proc.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * Run `fn` once `ms` has passed, unless the returned cancel runs first. The
   * bound on a race (settle's ask of a backend's channel): unlike `sleep`, it
   * can be called off when the other side answers, and it never holds the
   * process open on its own (the real one is `unref`ed).
   */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => sleep(ms),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};
