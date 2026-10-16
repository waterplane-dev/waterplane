#!/usr/bin/env node
// `node scripts/oswrap.mjs <task> -- <posix command…>`: on Windows, the task goes to
// scripts/windows/host.mjs (the host runs inside WSL there); anywhere else the POSIX command runs
// unchanged. npm runs scripts under cmd.exe on Windows, where `bash` is WSL's launcher and
// `pkill`/`VAR=x cmd` do not exist — so a root script that touches the daemon names both routes.
//
// A posix command that ends in `--` takes the caller's arguments (`npm run doctor -- --json`): npm
// appends them after that `--`, which a nested `npm run` forwards instead of parsing as its own
// config, and on Windows they are handed to the task. Without it `--json` never reached the doctor.
//
// Inside WSL on a Windows checkout (`/mnt/<drive>/…`) `stop` goes to Windows too, the way
// scripts/restart.sh hands `restart` over: that host is held by a Windows keeper, which only a stop
// flag written on the Windows side keeps from restarting it — and the POSIX `pkill -f …main.js`
// stopped EVERY install's daemon in the distro, not this one's. macOS and Linux are unchanged.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const cut = argv.indexOf("--");
const task = argv[0];
const posix = cut >= 0 ? argv.slice(cut + 1) : [];
const extraCut = posix.indexOf("--");
const extras = extraCut >= 0 ? posix.slice(extraCut + 1) : [];
const wslWindowsCheckout = () => {
  if (process.platform !== "linux" || !/^\/mnt\/[a-z]\//i.test(process.cwd())) return false;
  try { return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; }
};
if (task === "stop" && wslWindowsCheckout()) {
  // RUN cmd.exe first: with WSL interop off it is still on PATH and dies with "Exec format error".
  if (spawnSync("cmd.exe", ["/d", "/c", "exit 0"], { stdio: "ignore" }).status !== 0) {
    console.error("[stop] refused: this checkout's host is held by a Windows keeper, and WSL interop is off here (Windows programs cannot be run from this distro). " +
      "From PowerShell in the checkout: npm run stop. To get interop back: `wsl --shutdown` from Windows (every WSL session stops), " +
      "or as root in this distro: sudo sh -c 'echo :WSLInterop:M::MZ::/init:PF > /proc/sys/fs/binfmt_misc/register'");
    process.exit(1);
  }
  console.log("[stop] Windows checkout — handing the stop to Windows (scripts/windows/host.mjs)…");
  process.exit(spawnSync("cmd.exe", ["/d", "/c", "npm run stop"], { stdio: "inherit" }).status ?? 1);
}
const r = process.platform === "win32"
  ? spawnSync(process.execPath, [fileURLToPath(new URL("./windows/host.mjs", import.meta.url)), task, ...extras], { stdio: "inherit" })
  : spawnSync(posix.join(" "), { stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
