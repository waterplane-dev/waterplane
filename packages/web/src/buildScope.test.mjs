import test from "node:test";
import assert from "node:assert/strict";
import { localAfterSave, buildScopeNote } from "./buildScope.ts";

test("local is sent only when the host sent localIds, and follows the edit", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(localAfterSave(undefined, list, { id: "a", local: true }), undefined);
  assert.deepEqual(localAfterSave(["b"], list), ["b"]);
  assert.deepEqual(localAfterSave(["b"], list, { id: "a", local: true }), ["b", "a"]);
  assert.deepEqual(localAfterSave(["b", "a"], list, { id: "a", local: false }), ["b"]);
  assert.deepEqual(localAfterSave([], list, { id: "a", local: false }), []);
});

test("a deleted build leaves the local list with it", () => {
  assert.deepEqual(localAfterSave(["a", "b"], [{ id: "b" }]), ["b"]);
  assert.deepEqual(localAfterSave(["a"], [{ id: "b" }], { id: "a", local: true }), []);
});

test("the scope sentence names the file; an override says other checkouts keep theirs", () => {
  assert.match(buildScopeNote(false, true), /every checkout/);
  assert.match(buildScopeNote(true, true), /other checkouts keep the shared one/);
  assert.doesNotMatch(buildScopeNote(true, false), /other checkouts/);
});
