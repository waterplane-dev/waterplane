/** node --test packages/web/src/storeLoss.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { lossLineText, lossBytesNote, neverUsedHeading, ceilingState, lossWhenAt, lossHidesFigures } from "./storeLoss.ts";

const base = { id: "x", store: "ui-usage.json", path: "/s/ui-usage.json", at: 100, kind: "corrupt", error: "bad json", movedTo: "/s/ui-usage.json.corrupt-1" };

test("the line carries the one sentence, the time and the way to details", () => {
  const t = lossLineText(base, (ts) => `at ${ts}`);
  assert.equal(t, "ui-usage.json was lost, at 100.");
  assert.doesNotMatch(t, /bad json|\/s\//, "no raw error or path on the banner");
  assert.doesNotMatch(t, /Details in/);
});
test("a repeated write failure is dated by its last repeat", () => {
  assert.equal(lossWhenAt({ ...base, lastAt: 500 }), 500);
});
test("bytes note: left in place, gone, or already in the sentence", () => {
  assert.match(lossBytesNote({ ...base, movedTo: null }), /left in place/);
  assert.match(lossBytesNote({ ...base, movedToExists: false }), /gone/);
  assert.equal(lossBytesNote(base), null);
  assert.equal(lossBytesNote({ ...base, kind: "write-failed" }), null);
});
test("never used is not printed while a loss is present", () => {
  assert.match(neverUsedHeading(3, base), /no count since the record was lost/);
  assert.doesNotMatch(neverUsedHeading(3, base), /never used/);
  assert.equal(neverUsedHeading(3, undefined), "never used (3)");
  assert.equal(neverUsedHeading(0, undefined), null);
});
test("a ceiling reads off only when no record was lost", () => {
  assert.equal(ceilingState(null, undefined), "off");
  assert.equal(ceilingState(null, base), "not known");
  assert.equal(ceilingState(80, undefined), "80%");
  assert.match(ceilingState(80, base), /stale/);
});
test("only a corrupt or unreadable store hides figures; a failed save keeps memory intact", () => {
  assert.equal(lossHidesFigures(undefined), false);
  assert.equal(lossHidesFigures(null), false);
  assert.equal(lossHidesFigures(base), true);
  assert.equal(lossHidesFigures({ ...base, kind: "unreadable" }), true);
  const wf = { ...base, kind: "write-failed" };
  assert.equal(lossHidesFigures(wf), false);
  assert.equal(ceilingState(null, wf), "off");
  assert.equal(ceilingState(80, wf), "80%");
  assert.equal(neverUsedHeading(3, wf), "never used (3)");
});
