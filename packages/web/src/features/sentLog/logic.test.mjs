import test from "node:test";
import assert from "node:assert/strict";

import { SENT_CAP, mergeSent } from "./logic.ts";

test("a new entry lands newest-first", () => {
  const out = mergeSent([{ id: "a", ts: 10 }, { id: "b", ts: 5 }], { id: "c", ts: 20 });
  assert.deepEqual(out.map((e) => e.id), ["c", "a", "b"]);
});

test("a correction replaces its row by id and keeps its place by time", () => {
  const prev = [{ id: "a", ts: 30 }, { id: "b", ts: 20, result: "ambiguous" }, { id: "c", ts: 10 }];
  const out = mergeSent(prev, { id: "b", ts: 20, result: "settled" });
  assert.deepEqual(out.map((e) => e.id), ["a", "b", "c"]);
  assert.equal(out.length, 3);
  assert.equal(out[1].result, "settled");
});

test("the list is capped", () => {
  const prev = Array.from({ length: SENT_CAP }, (_, i) => ({ id: `e${i}`, ts: SENT_CAP - i }));
  const out = mergeSent(prev, { id: "new", ts: SENT_CAP + 1 });
  assert.equal(out.length, SENT_CAP);
  assert.equal(out[0].id, "new");
  assert.equal(out.at(-1).id, `e${SENT_CAP - 2}`);
});

test("the input is not mutated", () => {
  const prev = [{ id: "a", ts: 1 }];
  mergeSent(prev, { id: "b", ts: 2 });
  assert.deepEqual(prev, [{ id: "a", ts: 1 }]);
});
