/**
 * Replaces `tools/repohealth/statefile.mjs` in the bundled engine (esbuild `health-statefile`).
 * Same exports. With `WATERPLANE_VSCODE_HEALTH_DIR` set — the extension always sets it — every
 * state file goes into that directory (VS Code's global storage), never into the measured folder.
 * Without it, the original rule, unchanged.
 *
 * `WATERPLANE_VSCODE_HEALTH_READ_FROM` (a folder's state dir) wins over that, and is set only for
 * the read-only `status` / `plot` steps when the folder's own series is the one shown
 * (`healthsource.ts`): the engine reads `<dir>/<name>` and, those steps never writing, nothing in
 * the folder changes. `update` never gets it, so a measure can only land in the global storage.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRAND, LEGACY, envName } from "@waterplane/shared";

/** Every state dir name, current first. */
export const STATE_DIRS: string[] = [BRAND.stateDirName, ...LEGACY.map((l) => l.stateDirName)];

export function stateFile(root: string, name: string): string {
  const from = process.env[envName("VSCODE_HEALTH_READ_FROM")];
  if (from) return join(from, name);
  const dir = process.env[envName("VSCODE_HEALTH_DIR")];
  if (dir) return join(dir, name);
  for (const d of STATE_DIRS) {
    const p = join(root, d, name);
    if (existsSync(p)) return p;
  }
  for (const d of STATE_DIRS) {
    if (existsSync(join(root, d))) return join(root, d, name);
  }
  return join(root, BRAND.stateDirName, name);
}
