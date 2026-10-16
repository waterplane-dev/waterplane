// `doctor --json`: the report an installing agent reads. Pins the shape it loops over, and the
// native-Windows short-circuit that replaces it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeWindowsCheck, reportJson } from "../dist/doctor.js";

test("reportJson: ok is false exactly when a check failed, counts match, checks pass through", () => {
  const checks = [
    { id: "node", status: "ok", detail: "node 24" },
    { id: "tmux", status: "warn", detail: "old", fix: "upgrade" },
    { id: "claude-login", status: "fail", detail: "not signed in", fix: "run claude" },
  ];
  const r = JSON.parse(reportJson(checks));
  assert.deepEqual({ ok: r.ok, fails: r.fails, warns: r.warns }, { ok: false, fails: 1, warns: 1 });
  assert.deepEqual(r.checks, checks);
  assert.equal(JSON.parse(reportJson(checks.slice(0, 2))).ok, true);
});

test("nativeWindowsCheck: one failure naming WSL2 on win32, nothing elsewhere", () => {
  const c = nativeWindowsCheck("win32");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /WSL2/);
  assert.match(c.fix, /wsl --install/);
  assert.equal(nativeWindowsCheck("linux"), null);
  assert.equal(nativeWindowsCheck("darwin"), null);
});
