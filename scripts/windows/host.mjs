#!/usr/bin/env node
// The host on Windows, from a checkout: built here, RUN inside WSL from this same checkout.
//
//   node scripts/windows/host.mjs setup | start | stop | restart | doctor | status | dev | autostart [--remove] | pair | version
//
// The launcher itself is `packages/host/src/cli/windows.ts` — the same code an npm install runs as
// `<slug> setup|start|…` on Windows, so the checkout and the package cannot drift. This file only
// makes sure it is built: before the first build there is nothing to import, so it builds once.
// The root `restart`, `stop`, `start`, `doctor` and `dev` scripts reach it through `scripts/oswrap.mjs`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (process.platform !== "win32") {
  console.error("[host] this launcher is for Windows; elsewhere use `npm run restart`.");
  process.exit(1);
}
// node_modules installed from WSL (`npm ci` in /mnt/<drive>/…) holds Linux binaries and no `.cmd`
// shims, so every build here then dies with cmd.exe's "tsc not found" in the system language. The
// tasks that go on to build or run reinstall here themselves: the update steps typed into a session
// (a WSL shell) end in exactly this state, and a refusal left the old host and the old UI running.
const TSC = join(REPO, "node_modules/.bin/tsc.cmd");
if (existsSync(join(REPO, "node_modules")) && !existsSync(TSC)) {
  const was = "[host] node_modules was installed from WSL (Linux binaries, no tsc.cmd) — this checkout builds on Windows.";
  if (!["restart", "start", "setup", "dev"].includes(process.argv[2])) {
    console.error(`${was}\n       \`npm run restart\` reinstalls it here; from WSL:  cmd.exe /d /c "npm run restart"`);
    process.exit(1);
  }
  console.log(`${was}\n       Reinstalling here (npm ci)…`);
  const r = spawnSync("npm ci", { cwd: REPO, shell: true, stdio: "inherit", windowsHide: true });
  if (r.status !== 0 || !existsSync(TSC)) { console.error("[host] npm ci failed — the host is left as it was. Fix the lines above, then run this again."); process.exit(1); }
}
const launcher = join(REPO, "packages/host/dist/cli/windows.js");
// The build just run IS the one `restart` would run next: ~100 s each on the first Windows box, so
// the launcher is told (`justBuilt`) and skips its own.
let justBuilt = false;
if (!existsSync(launcher)) {
  console.log("[host] first build (npm run build)…");
  const r = spawnSync("npm run build", { cwd: REPO, shell: true, stdio: "inherit", windowsHide: true });
  if (r.status !== 0 || !existsSync(launcher)) { console.error("[host] the build failed — fix the lines above, then run this again."); process.exit(1); }
  justBuilt = true;
}
const { run } = await import(pathToFileURL(launcher).href);
process.exit(await run(process.argv.slice(2), REPO, { justBuilt }));
