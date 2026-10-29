/**
 * The scorecard sheet's cuts and words (`logic.ts`, read straight off the TypeScript).
 *
 *     node --test packages/extensions/scorecard/web/logic.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshWords, remedyWords, reasonKey, slugKey, cutChecks, openChecks, reasonProblem, scoreChip, sections, slugProblem } from "./logic.ts";

const c = (name, score, o = {}) => ({ name, score, reason: "", details: [], docUrl: null, short: "", failing: score >= 0 && score < 10, ...o });
const view = (o = {}) => ({
  repo: "r", slug: "a/b", slugFrom: "remote", score: 6, checks: [
    c("A", 3), c("B", 0, { accepted: { reason: "solo" } }), c("C", 10), c("D", -1), c("E", 9, { accepted: undefined }),
  ], open: 2, readAt: 1, ...o,
});

test("open checks are failing and not accepted", () => {
  assert.deepEqual(openChecks(view()).map((x) => x.name), ["A", "E"]);
});

test("chip number and cut are the same list", () => {
  const v = view();
  assert.equal(scoreChip(v).n, cutChecks(v, { repo: "r" }).length);
  assert.equal(cutChecks(v, null), null);
});

test("chip is absent when unscored, absent or nothing open", () => {
  assert.equal(scoreChip(null), null);
  assert.equal(scoreChip(view({ score: null, checks: [] })), null);
  assert.equal(scoreChip(view({ checks: [c("C", 10)] })), null);
});

test("chip words", () => {
  const ch = scoreChip(view());
  assert.equal(ch.label, "failing");
  assert.equal(ch.title, "OpenSSF Scorecard 6/10 — 2 failing checks");
  assert.match(scoreChip(view({ checks: [c("A", 1)] })).title, /1 failing check$/);
});

test("sections split; inconclusive counts as passing", () => {
  const s = sections(view());
  assert.deepEqual([s.open.length, s.accepted.length, s.passing.length], [2, 1, 2]);
});

test("slug and reason validation say why", () => {
  assert.equal(slugProblem("waterplane-dev/waterplane"), null);
  assert.match(slugProblem(""), /owner\/name/);
  assert.match(slugProblem("nope"), /not an owner\/name/);
  assert.equal(reasonProblem("fine", 500), null);
  assert.match(reasonProblem("  ", 500), /required/);
  assert.match(reasonProblem("x".repeat(501), 500), /500/);
});

test("remedy receipt words by existing and state", () => {
  assert.match(remedyWords("A", { existing: false }), /^A is in the backlog, waiting/);
  assert.match(remedyWords("A", { existing: true, state: "queued" }), /already in the backlog, waiting/);
  assert.match(remedyWords("A", { existing: true }), /already in the backlog/);
  assert.match(remedyWords("A", { existing: true, state: "done" }), /already in the backlog \(done\)/);
});

test("draft keys are per repo and check", () => {
  assert.notEqual(reasonKey("r1", "A"), reasonKey("r2", "A"));
  assert.notEqual(reasonKey("r1", "A"), reasonKey("r1", "B"));
  assert.notEqual(reasonKey("r1", "A"), slugKey("r1"));
});

test("refreshWords: unchanged, new, local", () => {
  const u = refreshWords("2026-10-01T00:00:00Z", { date: "2026-10-01T00:00:00Z", slug: "a/b" });
  assert.match(u, /still from 2026-10-01/);
  assert.match(u, /a\/b/);
  assert.match(u, /push to main/);
  assert.equal(refreshWords("2026-10-01T00:00:00Z", { date: "2026-10-08T00:00:00Z" }), "New scan from 2026-10-08.");
  assert.match(refreshWords("x", { date: "x", local: true }), /exposure watch/);
  assert.match(refreshWords("a", { date: "b", local: true }), /^New local reading from b/);
  assert.equal(refreshWords(undefined, {}), null);
});
