/**
 * The requirements setup row's WORDS, pinned byte for byte. They used to live in
 * `web/src/setupRemedy.ts` (a GUIDANCE entry and two `=== "requirements"` branches) and moved here when
 * the row became the extension's to describe. Nothing about what a person reads may change in the move.
 *
 *     node --test packages/extensions/requirements/web/setupRow.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { agentVerb, fixVerb, remedyPrompt, setupRowLookup } from "../../../web/src/setupRemedy.ts";
import { REQUIREMENTS_ROW } from "./setupRow.ts";

const GUIDANCE =
  "Run the command quoted above from the repo root; it spends a few cents of model calls and leaves an " +
  "uncommitted diff under `docs/requirements/`. Do not commit it. Then check the diff the way the run cannot: " +
  "for each item still marked `requested`, look in the code — if it is clearly there, change its status line " +
  "to `shipped` and add the commit that brought it (`git log -S`/`git blame`). Flag duplicates, items that " +
  "describe a change rather than an end state, and anything that contradicts another item. Touch nothing else " +
  "in the list, and end with a short summary of the diff for me to review.";

const check = { id: "requirements", label: "Requirements list", status: "pass", scope: "repo",
  detail: "Set up, never built. Build it from the repo root: node /u/scripts/requirements/update.mjs ." };

test("the row's words are the ones the core used to carry", () => {
  assert.equal(REQUIREMENTS_ROW.check, "requirements");
  assert.equal(REQUIREMENTS_ROW.fix, "requirements");
  assert.equal(REQUIREMENTS_ROW.fixVerb, "set up");
  assert.equal(REQUIREMENTS_ROW.agentVerb, "update the list in this repo");
  assert.equal(REQUIREMENTS_ROW.guidance, GUIDANCE);
});

test("through the lookup the core draws exactly what it drew before", () => {
  const rows = setupRowLookup([REQUIREMENTS_ROW]);
  assert.deepEqual(rows.refused, []);
  assert.equal(fixVerb("requirements", undefined, rows), "set up");
  assert.equal(agentVerb("requirements", rows), "update the list in this repo");
  assert.equal(fixVerb("gitignore", undefined, rows), "fix");
  assert.equal(agentVerb("claude-md", rows), "fix in this repo");
  const p = remedyPrompt([check], "child-paint", rows);
  assert.ok(p.includes("node /u/scripts/requirements/update.mjs ."), "quotes the command from detail");
  assert.ok(p.includes(`   ${GUIDANCE}`));
  assert.match(p, /Do not commit/);
});
