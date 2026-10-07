/**
 * Finding `claude` when it is not on PATH — from injected facts, never the real machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaudeBin, tilde } from "../dist/claudebin.js";

const home = "/home/me";
const mk = (present = [], over = {}) => ({
  platform: "linux", home, env: {}, wsl: false,
  exists: (p) => present.includes(p),
  onPath: () => false,
  readdir: () => [],
  ...over,
});

test("the knob wins over everything", () => {
  const r = findClaudeBin(mk([`${home}/.local/bin/claude`], { knob: "/x/claude", onPath: () => true }));
  assert.deepEqual(r, { bin: "/x/claude", source: "env", tried: [] });
});

test("PATH wins over a usual location", () => {
  const r = findClaudeBin(mk([`${home}/.local/bin/claude`], { onPath: (n) => n === "claude" }));
  assert.equal(r.bin, "claude");
  assert.equal(r.source, "path");
});

test("the first existing usual location wins, in order", () => {
  const r = findClaudeBin(mk(["/usr/local/bin/claude", `${home}/.bun/bin/claude`, `${home}/.claude/local/claude`]));
  assert.equal(r.bin, `${home}/.claude/local/claude`);
  assert.equal(r.source, "found");
  assert.deepEqual(r.tried, [`${home}/.local/bin/claude`, `${home}/.claude/local/claude`]);
});

test("npm_config_prefix is honoured", () => {
  const r = findClaudeBin(mk(["/opt/npm/bin/claude"], { env: { npm_config_prefix: "/opt/npm" } }));
  assert.equal(r.bin, "/opt/npm/bin/claude");
});

test("the newest nvm node wins", () => {
  const nvm = `${home}/.nvm/versions/node`;
  const r = findClaudeBin(mk([`${nvm}/v20.9.0/bin/claude`, `${nvm}/v22.1.0/bin/claude`], {
    readdir: (p) => (p === nvm ? ["v20.9.0", "v22.1.0", "v9.0.0"] : []),
  }));
  assert.equal(r.bin, `${nvm}/v22.1.0/bin/claude`);
});

test("win32 looks at %APPDATA%\\npm and the native installer", () => {
  const appdata = "C:\\Users\\me\\AppData\\Roaming";
  const a = findClaudeBin(mk([`${appdata}\\npm\\claude.cmd`], { platform: "win32", home: "C:\\Users\\me", env: { APPDATA: appdata, USERPROFILE: "C:\\Users\\me" } }));
  assert.equal(a.bin, `${appdata}\\npm\\claude.cmd`);
  const b = findClaudeBin(mk(["C:\\Users\\me\\.local\\bin\\claude.exe"], { platform: "win32", home: "C:\\Users\\me", env: { USERPROFILE: "C:\\Users\\me" } }));
  assert.equal(b.bin, "C:\\Users\\me\\.local\\bin\\claude.exe");
  assert.equal(b.source, "found");
});

test("WSL: a Windows-side install is reported, never used", () => {
  const w = "/mnt/c/Users/me/AppData/Roaming/npm/claude.cmd";
  const r = findClaudeBin(mk([w], { wsl: true, readdir: (p) => (p === "/mnt/c/Users" ? ["Public", "me"] : []) }));
  assert.equal(r.bin, "claude");
  assert.equal(r.windowsSide, w);
  assert.notEqual(r.source, "found");
});

test("WSL: a Linux-side install still wins over the Windows one", () => {
  const r = findClaudeBin(mk([`${home}/.local/bin/claude`, "/mnt/c/Users/me/.local/bin/claude.exe"], { wsl: true, readdir: () => ["me"] }));
  assert.equal(r.bin, `${home}/.local/bin/claude`);
  assert.equal(r.windowsSide, undefined);
});

test("nothing found: plain claude, with what was tried", () => {
  const r = findClaudeBin(mk());
  assert.equal(r.bin, "claude");
  assert.ok(r.tried.length >= 7);
  assert.equal(r.windowsSide, undefined);
});

test("tilde abbreviates home only", () => {
  assert.equal(tilde("/home/me/.local/bin/claude", home), "~/.local/bin/claude");
  assert.equal(tilde("/home/meow/x", home), "/home/meow/x");
});
