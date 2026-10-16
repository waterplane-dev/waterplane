/**
 * The marks a person puts on a session by hand, held while the link is down
 * (`pendingMarks.ts`): the star and the follow-up flag share ONE mechanism —
 * painted over the host's value, retired the moment a live row agrees.
 *
 *     node --test packages/web/src/pendingMarks.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FOLLOWUP_MARK, STAR_MARK, applyPendingMarks, parsePendingMarks, reconcileMarks } from "./pendingMarks.ts";

const ses = (id, o = {}) => ({ id, cwd: "/r", title: id, ...o });
const agentFlag = { by: "agent", at: 5, reason: "read the plan" };

test("nothing pending hands back the same array (no re-render)", () => {
  const list = [ses("a")];
  assert.equal(applyPendingMarks(list, {}, STAR_MARK), list);
  assert.equal(applyPendingMarks(list, { a: false }, STAR_MARK), list, "already what was asked");
});

test("a flag pressed offline is painted as the person's own, and a clear removes whoever set it", () => {
  const list = [ses("a"), ses("b", { followUp: agentFlag })];
  const out = applyPendingMarks(list, { a: true, b: false }, FOLLOWUP_MARK);
  assert.equal(out[0].followUp.by, "hand");
  assert.equal("followUp" in out[1], false);
  // an existing flag is never repainted as the person's
  assert.equal(applyPendingMarks(list, { b: true }, FOLLOWUP_MARK)[1].followUp, agentFlag);
});

test("a press retires when a live row agrees; only an authoritative list drops a vanished one", () => {
  const live = [ses("a", { followUp: { by: "hand", at: 9 } }), ses("b")];
  assert.deepEqual(reconcileMarks({ a: true, b: true }, live, false, FOLLOWUP_MARK), { b: true });
  assert.equal(reconcileMarks({ b: true }, live, false, FOLLOWUP_MARK), null, "unchanged → null");
  assert.deepEqual(reconcileMarks({ gone: true }, live, true, FOLLOWUP_MARK), {});
  assert.equal(reconcileMarks({ gone: true }, live, false, FOLLOWUP_MARK), null);
  // the star reads its own field, never the flag's
  assert.deepEqual(reconcileMarks({ a: true }, live, false, STAR_MARK), null);
});

test("a stored record keeps booleans only, and a broken one is empty", () => {
  assert.deepEqual(parsePendingMarks('{"a":true,"b":"yes","c":false}'), { a: true, c: false });
  assert.deepEqual(parsePendingMarks("not json"), {});
  assert.deepEqual(parsePendingMarks("[1]"), {});
  assert.deepEqual(parsePendingMarks(null), {});
});
