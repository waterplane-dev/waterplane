import { test } from "node:test";
import assert from "node:assert/strict";
import { checksHint, commitVerbs, verdictWords } from "./gitChecks.ts";

const exact = { prePush: { testsCommit: true }, outgoingTotal: 5 };
const tree = { prePush: { testsCommit: false }, outgoingTotal: 5 };
const passed = { ok: true, at: 1 };
const failed = { ok: false, at: 1 };

test("no hook: no verbs, nothing explained", () => {
  assert.deepEqual(commitVerbs({ outgoingTotal: 5 }, 0), { check: false });
  assert.equal(checksHint({ outgoingTotal: 5 }), null);
});

test("a hook that tests the commit: any commit can be checked, a passed one pushed up to", () => {
  assert.deepEqual(commitVerbs(exact, 3), { check: true });
  assert.deepEqual(commitVerbs(exact, 3, failed), { check: true });
  assert.deepEqual(commitVerbs(exact, 3, passed), { check: false, pushes: 2 });
  assert.deepEqual(commitVerbs(exact, 0, passed), { check: false, pushes: 5 });
});

test("a hook that tests the tree: only the newest commit, and never a partial push", () => {
  assert.deepEqual(commitVerbs(tree, 0), { check: true });
  assert.deepEqual(commitVerbs(tree, 1), { check: false });
  assert.deepEqual(commitVerbs(tree, 1, passed), { check: false });
  assert.match(checksHint(tree), /working tree/);
  assert.equal(checksHint({ ...tree, outgoingTotal: 1 }), null);
});

test("the verdict says which way it went", () => {
  assert.equal(verdictWords(passed, "2h ago"), "checks passed 2h ago");
  assert.equal(verdictWords(failed, "2h ago"), "checks failed 2h ago");
});
