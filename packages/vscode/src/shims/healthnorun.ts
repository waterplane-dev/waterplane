/**
 * Replaces `node:child_process` for `tools/repohealth/own.mjs` ONLY, in the bundled engine
 * (esbuild `health-norun`). `own.mjs`'s `runReading` is what spawns a command a repo declares in
 * `.waterplane-shared/health.json` — its own readings (`readings[].run`) and an override of a
 * central one (`central.<key>.run`, through `central.mjs`). The desktop app runs those (the same
 * trust as a repo's build commands); the extension does not: its promise is that the one program
 * it starts is `git`, and a folder opened in VS Code is not a repo somebody chose to trust with
 * code execution.
 *
 * So `spawnSync` throws, `runReading` catches it, and every such reading is ABSENT on the row with
 * the reason `could not start <cmd>: <NO_RUN>` — never dropped, never 0. A disable needs nothing
 * run and is honoured as on the desktop. The view repeats the reason once, as a sentence.
 */
export const NO_RUN = "the VS Code extension runs only git, never a command a repo declares";

export function spawnSync(): never {
  throw new Error(NO_RUN);
}
