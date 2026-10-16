/**
 * The WSL preflight, from injected facts — never the real machine. What is
 * pinned: detection from a /proc/version string, which paths count as a Windows
 * drive, and which fact produces which check id and status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findKeepTask, interopFromProbe, isWsl, keepAliveCommand, keepTaskNames, launcherTaskName, onWindowsDrive, pid1IsSystemd, wslChecks } from "../dist/doctorwsl.js";

const WSL_VER = "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@build) (gcc)";
const LINUX_VER = "Linux version 6.8.0-45-generic (buildd@lcy02) (gcc)";
const base = {
  procVersion: WSL_VER, release: "5.15.153.1-microsoft-standard-WSL2", pid1Comm: "systemd\n",
  tailscaleIp: "100.64.0.5", root: "/home/me/dev", claudePath: "/home/me/.local/bin/claude",
  keepTask: null, keepAliveCmd: "`waterplane service install` inside WSL", interop: "ok",
};
const byId = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));

test("detection: microsoft or WSL in /proc/version or the release", () => {
  assert.equal(isWsl(WSL_VER, "6.8.0"), true);
  assert.equal(isWsl(null, "4.4.0-19041-Microsoft"), true);
  assert.equal(isWsl(LINUX_VER, "6.8.0-45-generic"), false);
  assert.equal(isWsl(null, "25.6.0"), false);
});

test("not WSL: no checks at all", () => {
  assert.deepEqual(wslChecks({ ...base, procVersion: LINUX_VER, release: "6.8.0-generic" }), []);
});

test("windows drive classification", () => {
  assert.equal(onWindowsDrive("/mnt/c"), true);
  assert.equal(onWindowsDrive("/mnt/c/Users/me/dev"), true);
  assert.equal(onWindowsDrive("/mnt/d/x"), true);
  assert.equal(onWindowsDrive("/mnt/wsl/x"), false);
  assert.equal(onWindowsDrive("/home/me/mnt/c"), false);
  assert.equal(onWindowsDrive("/mnt"), false);
});

test("systemd detection", () => {
  assert.equal(pid1IsSystemd("systemd\n"), true);
  assert.equal(pid1IsSystemd("init"), false);
  assert.equal(pid1IsSystemd(null), false);
});

test("healthy WSL: only the idle note is not ok", () => {
  const c = byId(wslChecks(base));
  assert.deepEqual(Object.keys(c), ["wsl-tailscale", "wsl-systemd", "wsl-interop", "wsl-idle", "wsl-root", "wsl-claude"]);
  assert.equal(c["wsl-interop"].status, "ok");
  assert.equal(c["wsl-tailscale"].status, "ok");
  assert.equal(c["wsl-systemd"].status, "ok");
  assert.equal(c["wsl-idle"].status, "warn");
  assert.equal(c["wsl-root"].status, "ok");
  assert.equal(c["wsl-claude"].status, "ok");
});

test("each problem fact yields its own verdict and a fix", () => {
  const c = byId(wslChecks({ ...base, tailscaleIp: null, pid1Comm: "init", root: "/mnt/c/dev", claudePath: "/mnt/c/Users/me/claude" }));
  assert.equal(c["wsl-tailscale"].status, "warn");
  assert.match(c["wsl-tailscale"].fix, /mirrored/);
  assert.match(c["wsl-tailscale"].fix, /wsl --shutdown/);
  assert.equal(c["wsl-systemd"].status, "warn");
  assert.match(c["wsl-systemd"].fix, /systemd=true/);
  assert.equal(c["wsl-root"].status, "warn");
  assert.equal(c["wsl-claude"].status, "fail");
  assert.match(c["wsl-claude"].fix, /inside WSL/);
});

test("claude not resolved: no wsl-claude row (claude-binary already says so)", () => {
  assert.equal(byId(wslChecks({ ...base, claudePath: null }))["wsl-claude"], undefined);
});

test("wsl-idle: ok only when Windows names a keep-alive task; none and unknown are different sentences", () => {
  const kept = byId(wslChecks({ ...base, keepTask: "waterplane-host" }))["wsl-idle"];
  assert.equal(kept.status, "ok");
  assert.match(kept.detail, /"waterplane-host"/);
  // Only existence is asked: the sentence claims no more (not enabled, not which install).
  assert.match(kept.detail, /a Windows task named "waterplane-host" exists/);
  const none = byId(wslChecks(base))["wsl-idle"];
  assert.equal(none.status, "warn");
  assert.match(none.detail, /no Windows task keeps it up/);
  assert.match(none.fix, /service install/);
  const unknown = byId(wslChecks({ ...base, keepTask: undefined }))["wsl-idle"];
  assert.equal(unknown.status, "warn");
  assert.match(unknown.detail, /could not be asked/);
});

test("the keep-alive command follows the install the host runs from", () => {
  assert.match(keepAliveCommand("checkout", "/mnt/c/dev/waterplane"), /node scripts\/windows\/host\.mjs autostart/);
  assert.match(keepAliveCommand("npm", "/mnt/c/Users/me/AppData/Roaming/npm/node_modules/waterplane"), /^`\S+ autostart` in PowerShell/);
  // A checkout or an npm install INSIDE the distro has no Windows launcher: service install prints the task.
  assert.match(keepAliveCommand("checkout", "/home/me/waterplane"), /service install/);
  assert.match(keepAliveCommand("tarball", "/home/me/.local/share/waterplane/versions/1.0.0"), /service install/);
  assert.ok(keepTaskNames().includes(`${keepTaskNames()[0]}`) && keepTaskNames()[0].endsWith("-host"));
});

test("keepTaskNames: both launcher tasks count — the checkout's old name and the npm install's own", () => {
  const names = keepTaskNames();
  assert.ok(names.includes("waterplane-host"), "the checkout's task, as already registered on a box");
  assert.ok(names.includes("waterplane-host-npm"), "the npm install's task");
  assert.equal(launcherTaskName("checkout"), "waterplane-host");
  assert.equal(launcherTaskName("npm"), "waterplane-host-npm");
  assert.equal(new Set(names).size, names.length);
});

test("findKeepTask: a yes names the task (the npm one too), all no is null, anything else is undefined", async () => {
  assert.equal(await findKeepTask(async (_bin, n) => (n === "waterplane-host-npm" ? "yes" : "no")), "waterplane-host-npm");
  assert.equal(await findKeepTask(async () => "no"), null);
  assert.equal(await findKeepTask(async () => "unknown"), undefined);
  // schtasks.exe off PATH, the full path answers: that answer counts.
  assert.equal(await findKeepTask(async (bin, n) => (bin === "schtasks.exe" ? "unknown" : n === "waterplane-host" ? "yes" : "no")), "waterplane-host");
});

test("interopFromProbe: Exec format error in any of its three shapes is off; no file or a timeout is unknown; a run is ok", () => {
  assert.equal(interopFromProbe({ ok: true }), "ok");
  assert.equal(interopFromProbe({ code: "ENOEXEC", message: "spawn ENOEXEC" }), "off");
  assert.equal(interopFromProbe({ code: 126, stderr: "" }), "off");
  assert.equal(interopFromProbe({ code: 1, message: "Command failed", stderr: "/mnt/c/Windows/System32/cmd.exe: cannot execute binary file: Exec format error" }), "off");
  assert.equal(interopFromProbe({ code: "ENOENT", message: "spawn /mnt/c/Windows/System32/cmd.exe ENOENT" }), "unknown");
  assert.equal(interopFromProbe({ code: null, message: "timed out", killed: true }), "unknown");
  assert.equal(interopFromProbe({ code: 1, message: "Command failed" }), "unknown", "cmd ran and failed: interop is not what broke");
});

test("wsl-interop: off is a warn naming what is lost and BOTH fixes; unknown or absent is no row at all", () => {
  const off = byId(wslChecks({ ...base, interop: "off" }))["wsl-interop"];
  assert.equal(off.status, "warn");
  for (const lost of [/MagicDNS/, /tailscale serve/, /HTTPS link/, /keep-alive task/, /npm run restart/, /git identity/]) assert.match(off.detail, lost);
  assert.match(off.fix, /wsl --shutdown/);
  assert.match(off.fix, /EVERY WSL session stops/);
  assert.ok(off.fix.includes("sudo sh -c 'echo :WSLInterop:M::MZ::/init:PF > /proc/sys/fs/binfmt_misc/register'"));
  assert.equal(byId(wslChecks({ ...base, interop: "unknown" }))["wsl-interop"], undefined);
  assert.equal(byId(wslChecks({ ...base, interop: undefined }))["wsl-interop"], undefined);
  // Placed before wsl-idle, whose "could not be asked" it explains.
  const ids = wslChecks({ ...base, interop: "off" }).map((c) => c.id);
  assert.equal(ids.indexOf("wsl-interop") + 1, ids.indexOf("wsl-idle"));
});

test("interop off: wsl-idle's could-not-ask points at it; wsl-tailscale stops blaming mirrored networking", () => {
  const c = byId(wslChecks({ ...base, interop: "off", keepTask: undefined, tailscaleIp: null }));
  assert.match(c["wsl-idle"].detail, /could not be asked.*interop is off \(wsl-interop\)/);
  assert.equal(c["wsl-tailscale"].status, "warn");
  assert.match(c["wsl-tailscale"].detail, /interop is off/);
  assert.doesNotMatch(c["wsl-tailscale"].fix, /networkingMode=mirrored/);
  // Interop on: the could-not-ask sentence does not invent the cause, and mirrored is the fix again.
  const on = byId(wslChecks({ ...base, keepTask: undefined, tailscaleIp: null }));
  assert.doesNotMatch(on["wsl-idle"].detail, /interop/);
  assert.match(on["wsl-tailscale"].fix, /networkingMode=mirrored/);
  // An IP visible with interop off: ok, and it says the Windows CLI's half is unknown here.
  const ip = byId(wslChecks({ ...base, interop: "off" }))["wsl-tailscale"];
  assert.equal(ip.status, "ok");
  assert.match(ip.detail, /tailscale\.exe cannot be run/);
});
