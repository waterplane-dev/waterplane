/**
 * The WSL preflight, from injected facts — never the real machine. What is
 * pinned: detection from a /proc/version string, which paths count as a Windows
 * drive, and which fact produces which check id and status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWsl, onWindowsDrive, pid1IsSystemd, wslChecks } from "../dist/doctorwsl.js";

const WSL_VER = "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@build) (gcc)";
const LINUX_VER = "Linux version 6.8.0-45-generic (buildd@lcy02) (gcc)";
const base = {
  procVersion: WSL_VER, release: "5.15.153.1-microsoft-standard-WSL2", pid1Comm: "systemd\n",
  tailscaleIp: "100.64.0.5", root: "/home/me/dev", claudePath: "/home/me/.local/bin/claude",
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
  assert.deepEqual(Object.keys(c), ["wsl-tailscale", "wsl-systemd", "wsl-idle", "wsl-root", "wsl-claude"]);
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
