/**
 * Build `packages/web` before every `cap sync`.
 *
 * `cap sync` copies `webDir` as it finds it, with no idea whether it is current.
 * Shipping an APK built from a stale `dist` is the kind of bug that costs an
 * afternoon on a phone, so the copy is never made from whatever happens to be on
 * disk — the build runs first, from the repo root, and a failure stops the sync
 * rather than producing an APK of the last good bundle.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");

if (!existsSync(join(root, "package.json"))) {
  console.error(`[app] cannot find the repo root (looked at ${root})`);
  process.exit(1);
}

console.log("[app] building packages/web …");
const r = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (r.status !== 0) {
  console.error("[app] web build failed — not syncing a stale bundle into the APK");
  process.exit(r.status ?? 1);
}

const dist = join(root, "packages", "web", "dist", "index.html");
if (!existsSync(dist)) {
  console.error(`[app] web build produced no ${dist}`);
  process.exit(1);
}
console.log("[app] web bundle ready");
