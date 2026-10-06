/**
 * The session-exit log line (`sessions/tmux.ts`'s `exitReport`). It exists
 * because unexplained exits on 2026-09-30 left nothing in the host log; each
 * clause is a fact that tells one cause from another, and each must degrade to
 * absent rather than throw.
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


const { exitReport } = await import("../dist/sessions.js");

const info = { id: "abcd1234", title: "myapp", cwd: "/Users/x/dev/myapp", createdAt: 1_000_000 };

test("code, signal and uptime are always there", () => {
  const line = exitReport(info, 0, 9, "/nonexistent/claude", 1_000_000 + 90_000);
  assert.match(line, /session exit · myapp \(abcd1234\) · myapp/);
  assert.match(line, /code 0 signal 9/);
  assert.match(line, /up 90s/);
});

test("an absent code and signal say none, never a number", () => {
  assert.match(exitReport(info, null, 0, "/nonexistent/claude", 1_000_000), /code none signal none/);
});

test("an unresolvable binary leaves its clause out instead of throwing", () => {
  assert.doesNotMatch(exitReport(info, 0, 0, "/nonexistent/claude"), /on disk changed/);
});

test("a binary that changed just before the exit says how long before", () => {
  const dir = mkdtempSync(join(tmpdir(), "exitreport-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, "");
  const t = 2_000_000_000; // seconds
  utimesSync(bin, t, t);
  assert.match(exitReport(info, 0, 0, bin, t * 1000 + 30_000), /claude on disk changed 30s ago/);
});
