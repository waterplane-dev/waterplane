/**
 * Replaces `node:child_process` for `tools/repohealth/metrics/native.mjs` ONLY, in the bundled
 * engine (esbuild `health-norun`). `native.mjs` runs a repo's own analyzers, vulnerability
 * scanner and type checker at the newest commit. The desktop app does; the extension does not —
 * its promise is that the one program it starts is `git` (see `healthnorun.ts` for own.mjs).
 *
 * Unlike own.mjs's shim this one does not throw: `native.mjs` reads a failed start off
 * `result.error` (`runTool`), so every native reading lands ABSENT with the reason
 * `<tool> could not be run (<NO_RUN>)` — never dropped, never 0.
 */
import { NO_RUN } from "./healthnorun.js";

export function spawnSync() {
  return { status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error(NO_RUN), { code: "WP_NO_RUN" }) };
}
