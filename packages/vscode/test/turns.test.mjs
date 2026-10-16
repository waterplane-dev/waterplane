// What each prompt cost: the same records as the cursor, so the turns SUM to
// its split and its cost — never a second tally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KINDS, LOG, data, pick, prompt, req, sumKinds, tmp } from "./helpers.mjs";

test("fixture: 3 turns, the slash command opens one, the tool_result does not", async () => {
  const rows = await data.turnCosts(LOG);
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 3]);
  assert.equal(rows[0].prompt, "Explain the build");
  assert.equal(rows[1].prompt, "/compact");
  assert.equal(rows[2].prompt, "Now fix the failing test");
  assert.deepEqual(rows.map((r) => r.requests), [2, 1, 3], "duplicate and <synthetic> refused; tool_result opens nothing");
  assert.equal(rows[2].ctxTok, 3 + 3900 + 100, "context the LAST request carried");
  assert.equal(rows[0].at, Date.parse("2026-10-01T10:00:00.000Z"));
});

test("Σ turn kinds == cursor.split field for field; Σ cost == cursor.cost.total", async () => {
  const rows = await data.turnCosts(LOG);
  const cur = data.updateContextLog(LOG, null);
  assert.deepEqual(sumKinds(rows.map((r) => r.kinds)), pick(cur.split));
  const usd = rows.reduce((n, r) => n + r.costUsd, 0);
  assert.ok(cur.cost.total > 0);
  assert.ok(Math.abs(usd - cur.cost.total) < 1e-9, `${usd} vs ${cur.cost.total}`);
  assert.ok(Math.abs(rows.at(-1).cumCostUsd - cur.cost.total) < 1e-9);
});

test("cumCostUsd is monotonic", async () => {
  const rows = await data.turnCosts(LOG);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].cumCostUsd >= rows[i - 1].cumCostUsd);
});

test("an unpriced model: that turn's cost is null, and the running total is null from there on", async () => {
  const p = join(tmp("unpriced"), "u.jsonl");
  writeFileSync(p, [
    prompt(0, "one"), req(1, "m1", { input: 10, output: 5 }),
    prompt(2, "two"), req(3, "m2", { input: 10, output: 5, model: "mystery-model-9" }), req(4, "m3", { input: 7, output: 1 }),
    prompt(5, "three"), req(6, "m4", { input: 10, output: 5 }),
  ].join("\n") + "\n");
  const rows = await data.turnCosts(p);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].costUsd > 0);
  assert.ok(rows[0].cumCostUsd > 0);
  assert.equal(rows[1].costUsd, null);
  assert.equal(rows[1].unpricedTok, 15);
  assert.equal(rows[1].cumCostUsd, null);
  assert.ok(rows[2].costUsd > 0, "a later priced turn still has its own cost");
  assert.equal(rows[2].cumCostUsd, null);
  // The cursor's split still holds every request.
  const cur = data.updateContextLog(p, null);
  assert.deepEqual(sumKinds(rows.map((r) => r.kinds)), pick(cur.split));
  assert.equal(cur.unpriced, 15);
});

test("requests before the first prompt are turn 0; none, no turn 0", async () => {
  const p = join(tmp("turn0"), "t.jsonl");
  writeFileSync(p, [req(0, "r0", { input: 4, output: 2 }), prompt(1, "hello"), req(2, "r1", { input: 4, output: 2 })].join("\n") + "\n");
  const rows = await data.turnCosts(p);
  assert.deepEqual(rows.map((r) => r.n), [0, 1]);
  assert.equal(rows[0].prompt, "");
  assert.deepEqual((await data.turnCosts(LOG)).map((r) => r.n)[0], 1);
});

test("incremental: appended records read through the cursor equal a fresh read", async () => {
  const p = join(tmp("incr"), "i.jsonl");
  writeFileSync(p, [prompt(0, "first"), req(1, "a", { input: 100, cw: 1000, output: 10 })].join("\n") + "\n");
  const c1 = data.advanceTurns(p, null);
  assert.equal(data.projectTurns(c1).length, 1);
  appendFileSync(p, [req(2, "b", { cr: 1000, input: 5, output: 20 }), prompt(3, "second"), req(4, "c", { cr: 1000, cw: 50, output: 7 })].join("\n") + "\n");
  const c2 = data.advanceTurns(p, c1);
  const fresh = await data.turnCosts(p);
  assert.deepEqual(data.projectTurns(c2), fresh);
  assert.equal(fresh[0].requests, 2);
  for (const k of KINDS) assert.ok(typeof fresh[1].kinds[k] === "number");
});

test("a missing log is no turns", async () => {
  assert.deepEqual(await data.turnCosts(join(tmp("gone"), "nope.jsonl")), []);
});

test("[Request interrupted by user…] is the end of a turn, not a prompt: no new turn, not open, not counted", () => {
  for (const note of ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]) {
    const p = join(tmp("intr"), "i.jsonl");
    writeFileSync(p, [prompt(0, "go"), req(1, "a", { input: 5, output: 2, stop: "tool_use" }), prompt(2, note)].join("\n") + "\n");
    const cur = data.advanceTurns(p, null);
    const rows = data.projectTurns(cur);
    assert.equal(rows.length, 1, note);
    assert.equal(rows[0].open, undefined, "the tail is final");
    assert.equal(rows[0].prompt, "go");
    assert.equal(cur.opened, 1);
    assert.deepEqual(sumKinds(rows.map((r) => r.kinds)), pick(data.updateContextLog(p, null).split), "turns still sum to the headline");
  }
  // A real prompt after the interruption opens its own turn as before.
  const p = join(tmp("intr2"), "i.jsonl");
  writeFileSync(p, [prompt(0, "go"), prompt(1, "[Request interrupted by user]"), prompt(2, "again")].join("\n") + "\n");
  const rows = data.projectTurns(data.advanceTurns(p, null));
  assert.deepEqual(rows.map((r) => r.prompt), ["go", "again"]);
  assert.equal(rows.at(-1).open, true);
});
