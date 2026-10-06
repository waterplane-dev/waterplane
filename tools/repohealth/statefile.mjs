/**
 * Where a repo's repo-health files live: `<repo>/<state dir>/<name>`.
 *
 * The state dir's name comes from `packages/shared/src/brand.ts` (current
 * first, then each legacy name), so a rename never strands a series. The rule
 * is PER FILE, not per directory: a file is used where it already is — under
 * the current dir name, else under a legacy one — because the series is
 * history that cannot be re-measured, and a `.waterplane/` created by some
 * other writer must not hide a `repohealth.jsonl` still sitting in the old dir.
 * A file that exists nowhere yet goes into whichever state dir already exists
 * (current first), else under the current name. Nothing here moves anything:
 * the repo-setup row's fix adopts a legacy dir whole.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRAND, LEGACY } from "../../packages/shared/dist/index.js";

/** Every state dir name, current first. */
export const STATE_DIRS = [BRAND.stateDirName, ...LEGACY.map((l) => l.stateDirName)];

/** The path of `name` under `root`'s state dir — see the header for the order. */
export function stateFile(root, name) {
  for (const d of STATE_DIRS) {
    const p = join(root, d, name);
    if (existsSync(p)) return p;
  }
  for (const d of STATE_DIRS) {
    if (existsSync(join(root, d))) return join(root, d, name);
  }
  return join(root, BRAND.stateDirName, name);
}
