// The whole-script hang guard every e2e script arms, in one place.
//
// A watchdog catches a HANG; it is not a speed check. Written inline, each
// script picked a number off its own solo run, and the full suite (ten
// scripts beside a Gradle build) is two to three times slower than that:
// e2e-setup's 15 s line fired on a run that was still passing every check,
// and that blocked a push. So the floor lives here and no script can go under
// it. Nothing imported, no side effects — safe for any script, including the
// ones that must not load lib-tmuxiso.
// `tools/e2ewatchdog.test.mjs` refuses an inline one.

export const WATCHDOG_FLOOR_MS = 45_000;

/** `setTimeout`'s shape and return value (so `.unref()` and `clearTimeout` still work), never under the floor. */
export function watchdog(onHang, ms = WATCHDOG_FLOOR_MS) {
  return setTimeout(onHang, Math.max(ms, WATCHDOG_FLOOR_MS));
}
