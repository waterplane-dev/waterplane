import test from "node:test";
import assert from "node:assert/strict";
import { cutTop, focusSpan } from "./tokenFocus.ts";

test("the costliest cut is the count: rows and sentence from one call", () => {
  const top = { rows: [{ id: "a" }, { id: "b" }, { id: "c" }], total: 3, tag: "" };
  const r = cutTop(top, ["b", "c"]);
  assert.deepEqual(r.top.rows.map((x) => x.id), ["b", "c"]);
  assert.match(r.bar, /^2 of 3 conversations shown/);
  assert.equal(cutTop(top, null).bar, null);
  assert.equal(cutTop(top, []).top.rows.length, 3);
});

test("a door's span becomes the sheet's span", () => {
  assert.deepEqual(focusSpan({ span: "30", box: "top" }), { id: "30", back: 0 });
  assert.equal(focusSpan({ box: "top" }), undefined);
  assert.equal(focusSpan(null), undefined);
});
