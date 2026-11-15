import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSetupShare, setupShareCompare } from "../dist/index.js";

const base = {
  kind: "agent-setup-block", schema: 1, from: "me", backend: "claude", models: ["claude-opus-4"], cli: ["2.1.0"],
  days: { from: "2026-01-01", to: "2026-01-05" }, startTok: 1000, groups: [{ group: "repo", chars: 100, parts: { constructor: 10 } }],
};

test("extra fields inside groups, days and repo are counted as dropped, not only top-level ones", () => {
  const r = parseSetupShare(JSON.stringify({ ...base, top: 1, days: { ...base.days, x: 1 }, groups: [{ ...base.groups[0], y: 2 }] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.dropped.sort(), ["days.x", "groups[].y", "top"]);
});

test("a part named like an inherited property is its own key, never the inherited function", () => {
  const a = parseSetupShare(JSON.stringify(base));
  const b = parseSetupShare(JSON.stringify({ ...base, groups: [{ group: "repo", chars: 100, parts: { toString: 5 } }] }));
  assert.ok(a.ok && b.ok);
  const c = setupShareCompare(a.block, b.block);
  const rows = c.groups[0].parts;
  assert.deepEqual(rows.map((x) => [x.key, x.mine, x.theirs]), [["constructor", 10, undefined], ["toString", undefined, 5]]);
});
