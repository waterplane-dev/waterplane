/**
 * The keyboard repo question's rows (`askRepoRows.ts`): primaries with no
 * filter, everything a filter matches, best match first.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { askRepoRows } from "./askRepoRows.ts";

const r = (repoName, branch, isPrimary = true) => ({ id: `${repoName}:${branch}`, repoName, branch, isPrimary, worktreePath: `/r/${repoName}/${branch}` });
const repos = [r("usher", "main"), r("usher", "fix-keys", false), r("ciqkit", "main"), r("newsroom", "main"), r("musician", "main")];

test("askRepoRows: no filter lists primaries only, in host order", () => {
  assert.deepEqual(askRepoRows(repos, "  ").map((x) => x.id), ["usher:main", "ciqkit:main", "newsroom:main", "musician:main"]);
});

test("askRepoRows: prefix before substring, primary before worktree, branches searched", () => {
  assert.deepEqual(askRepoRows(repos, "us").map((x) => x.id), ["usher:main", "usher:fix-keys", "musician:main"]);
  assert.deepEqual(askRepoRows(repos, "KEYS").map((x) => x.id), ["usher:fix-keys"]);
  assert.deepEqual(askRepoRows(repos, "zzz"), []);
});
