/**
 * The latest-request token: an awaited result is applied only if the request that started it is still
 * the current one (NAV-3: a slow remedy reply must not open the backlog after the sheet was left).
 *
 *     node --test packages/extensions/scorecard/web/latest.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { latest } from "./latest.ts";

test("a token is current until something newer begins", () => {
  const l = latest();
  const a = l.begin();
  assert.equal(l.current(a), true);
  const b = l.begin();
  assert.equal(l.current(a), false);
  assert.equal(l.current(b), true);
});

test("invalidate (the sheet was left) makes the pending token stale", () => {
  const l = latest();
  const a = l.begin();
  l.invalidate();
  assert.equal(l.current(a), false);
});

import { leaveResets, remedyOutcome } from "./latest.ts";
import { readFileSync } from "node:fs";

test("remedyOutcome: a current reply navigates on success and lands its error on the sheet", () => {
  assert.deepEqual(remedyOutcome(true, { ok: true, text: "A is in the backlog" }, "r", "A"), { navigate: true, toast: "A is in the backlog", sheetErr: null });
  assert.deepEqual(remedyOutcome(true, { ok: false, error: "boom" }, "r", "A"), { navigate: false, toast: null, sheetErr: "boom" });
});

test("remedyOutcome: a stale reply never navigates, and always says its outcome naming repo and check", () => {
  const ok = remedyOutcome(false, { ok: true, text: "A is in the backlog" }, "waterplane", "A");
  assert.equal(ok.navigate, false);
  assert.match(ok.toast, /^waterplane: A is in the backlog/);
  const bad = remedyOutcome(false, { ok: false, error: "fifty fixes filed" }, "waterplane", "Branch-Protection");
  assert.equal(bad.navigate, false);
  assert.match(bad.toast, /waterplane/);
  assert.match(bad.toast, /Branch-Protection/);
  assert.match(bad.toast, /fifty fixes filed/);
});

// Wiring is source-pinned: state.ts imports @waterplane/sdk, which node cannot load here.
const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

test("leaveResets: only a CLOSE resets the sheet; a cover — or no reason from an older core — keeps it", () => {
  assert.equal(leaveResets("close"), true);
  assert.equal(leaveResets("cover"), false);
  assert.equal(leaveResets(undefined), false);
});

test("wiring: onLeave takes the route's reason, every leave invalidates, only a close resets; × resets through onLeave", () => {
  const state = read("./state.ts");
  const index = read("./index.ts");
  assert.match(state, /export const leaveScorecard = \(reason\?: LeaveReason\) => \{\n  remedyToken\.invalidate\(\);\n  if \(leaveResets\(reason\)\) sheet\.set\(EMPTY\);/);
  assert.match(state, /export const closeScorecard = \(\) => \{ core\(\)\.nav\.close\(SCORE_SHEET\); \};/);
  assert.equal((state.match(/sheet\.set\(EMPTY\)/g) || []).length, 1, "one reset, in onLeave");
  assert.doesNotMatch(index, /keepStores/, "nothing is cleared on cover, so nothing is snapshotted: a restore would overwrite errors that arrived while covered");
  assert.match(index, /onLeave: leaveScorecard/);
  assert.match(state, /remedyOutcome\(remedyToken\.current\(token\)/);
});
