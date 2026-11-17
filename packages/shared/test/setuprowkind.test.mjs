/** setupRowKind: which group a checklist row is drawn in. node --test packages/shared/test/setuprowkind.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { setupRowKind, SETUP_QUALITY_CHECKS } from "../dist/index.js";

test("quality ids are quality", () => {
  for (const id of SETUP_QUALITY_CHECKS) assert.equal(setupRowKind({ id }), "quality");
  assert.deepEqual([...SETUP_QUALITY_CHECKS], ["context-weight", "skill-frontmatter", "auto-compact", "env-gitignored"]);
});
test("watch rows are watch, the rest install", () => {
  assert.equal(setupRowKind({ id: "x", watch: true }), "watch");
  assert.equal(setupRowKind({ id: "exposure:a", exposure: {} }), "watch");
  assert.equal(setupRowKind({ id: "claude-md" }), "install");
  assert.equal(setupRowKind({ id: "gitignore-transport" }), "install");
});
