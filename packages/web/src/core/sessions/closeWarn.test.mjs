/**
 * The close confirm's repo lines (`closeWarn.ts`): an unmerged count the host
 * could not read is said, never read as nothing to lose.
 *
 *     node --test packages/web/src/core/sessions/closeWarn.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeGitWarnings } from "./closeWarn.ts";

const base = { isRepo: true, dirty: false, unmerged: 0, isMain: false, mainBranch: "develop" };

test("a clean, fully merged branch has nothing to say", () => {
  assert.deepEqual(closeGitWarnings(base), []);
});

test("not a repo: nothing, whatever else the frame carries", () => {
  assert.deepEqual(closeGitWarnings({ ...base, isRepo: false, dirty: true, unmerged: 3, unmergedUnknown: true }), []);
});

test("unmerged commits name the base branch, falling back to main", () => {
  assert.deepEqual(closeGitWarnings({ ...base, unmerged: 2 }), ["• 2 commit(s) not merged to develop"]);
  assert.deepEqual(closeGitWarnings({ ...base, unmerged: 1, mainBranch: "" }), ["• 1 commit(s) not merged to main"]);
});

test("an unreadable count is said, not silence (the develop/trunk-repo bug)", () => {
  const w = closeGitWarnings({ ...base, unmergedUnknown: true });
  assert.equal(w.length, 1);
  assert.match(w[0], /could not check for unmerged commits/);
});

test("a known count wins over the unknown flag; the main checkout never warns about it", () => {
  assert.deepEqual(closeGitWarnings({ ...base, unmerged: 2, unmergedUnknown: true }), ["• 2 commit(s) not merged to develop"]);
  assert.deepEqual(closeGitWarnings({ ...base, isMain: true, unmergedUnknown: true, unmerged: 4 }), []);
});

test("dirty is reported alongside", () => {
  assert.deepEqual(closeGitWarnings({ ...base, dirty: true, unmergedUnknown: true }).length, 2);
});
