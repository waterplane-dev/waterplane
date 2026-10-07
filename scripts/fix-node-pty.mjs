// node-pty ships a `spawn-helper` binary in its prebuilds, but npm sometimes
// extracts it without the execute bit on macOS/Linux — which makes
// `pty.spawn` fail with "posix_spawnp failed". Restore +x.
//
// Run from `npm run build:shared`, not a postinstall: the repo's .npmrc sets
// ignore-scripts=true, so no install-time hook runs. Idempotent and silent
// when there is nothing to fix.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const prebuilds = "node_modules/node-pty/prebuilds";
// Windows has no exec bit (chmod only toggles read-only there), and printing a fix for
// darwin prebuilds on a Windows install reads like something went wrong.
if (process.platform === "win32" || !existsSync(prebuilds)) process.exit(0);

for (const dir of readdirSync(prebuilds)) {
  const helper = join(prebuilds, dir, "spawn-helper");
  try {
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0o111) continue;
    chmodSync(helper, mode | 0o111); // add execute for u/g/o
    console.log(`[fix-node-pty] chmod +x ${helper}`);
  } catch (err) {
    console.warn(`[fix-node-pty] could not chmod ${helper}:`, err.message);
  }
}
