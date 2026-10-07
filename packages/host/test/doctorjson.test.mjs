// `doctor --json`: the report an installing agent reads. Pins the shape it loops over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportJson } from "../dist/doctor.js";

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
