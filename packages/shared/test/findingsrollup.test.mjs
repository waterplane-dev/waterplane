/** The all-repos roll-up. node --test packages/shared/test/findingsrollup.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { repoRollup, repoRollupCut, findingCut, groupRuleOf } from "../dist/index.js";

const be = { understood: ["claude"], unread: [] };
const fnd = (repo, rule, o = {}) => ({ id: `repo.${rule}`, rule, scope: "repo", repo, kind: "quality", weight: "consider", what: `${rule} in ${repo}`, backends: be, evidence: null, remedy: { kind: "howto", text: "x" }, waive: { via: "ignore" }, ...o });
const pass = (repo, rule) => ({ id: `repo.${rule}`, rule, scope: "repo", repo, what: "ok", backends: be, at: 1 });
const res = (findings = [], passed = [], notChecked = []) => ({ findings, passed, notChecked });
const sv = (usd, tokens) => ({ ...(usd === undefined ? {} : { usd }), ...(tokens === undefined ? {} : { tokens }), per: "week", basis: "estimate", errs: "low" });
const r = (id, result, extra = {}) => ({ repoId: id, name: id.toUpperCase(), result, ...extra });

test("R-metrics-086: a rule in 3 of 5 repos is one group; the denominator leaves out repos where it did not run", () => {
  const roll = repoRollup([
    r("a", res([fnd("a", "efficiency-rules")])),
    r("b", res([fnd("b", "efficiency-rules")])),
    r("c", res([fnd("c", "efficiency-rules")])),
    r("d", res([], [pass("d", "efficiency-rules")])),
    r("e", res([], [], [{ rule: "efficiency-rules", scope: "repo", repo: "e", why: "unread" }])),
  ]);
  assert.equal(roll.groups.length, 1);
  const g = roll.groups[0];
  assert.deepEqual([g.repos.length, g.ranIn, g.unreadIn], [3, 4, 1]);
  assert.ok(!/ in [a-e]\b/.test(g.what), "the sentence carries no repo");
});

test("R-metrics-088: a repo that threw is notChecked and never clear; a clean one is clear", () => {
  const roll = repoRollup([r("a", res([], [pass("a", "x")])), { repoId: "b", name: "B", notChecked: "the collector threw" }]);
  assert.deepEqual(roll.clear.map((c) => [c.repoId, c.passed]), [["a", 1]]);
  assert.deepEqual(roll.notChecked, [{ repoId: "b", name: "B", why: "the collector threw" }]);
});

test("a repo with nothing open still says how many rules could not run", () => {
  const nc = (rule) => ({ rule, scope: "repo", repo: "a", why: "unread" });
  const roll = repoRollup([r("a", res([], [pass("a", "x")], [nc("y"), nc("z")]))]);
  assert.deepEqual(roll.clear.map((c) => [c.passed, c.notChecked]), [[1, 2]]);
});

test("R-metrics-089: repoRollupCut count equals its rows and the bar's N", () => {
  const roll = repoRollup([r("a", res([fnd("a", "r1")])), r("b", res([fnd("b", "r1")])), r("c", res()), { repoId: "d", name: "D" }]);
  const cut = repoRollupCut(roll, { rule: "r1" });
  assert.equal(cut.count, cut.rows.length);
  assert.equal(cut.count, 2);
  // The denominator is the repos the rule RAN in, the same number on every surface.
  assert.equal(cut.of, cut.group.ranIn);
  assert.equal(cut.of, 2);
  assert.equal(repoRollupCut(roll).of, 4, "with no rule: every repo in the overview");
  assert.equal(repoRollupCut(roll).count, roll.groups.length);
  assert.equal(repoRollupCut(roll, { rule: "nope" }).count, 0);
  // the repo's own cut lands on the same rows
  assert.equal(findingCut([fnd("a", "r1"), fnd("a", "r2")], { rule: "r1" }).count, 1);
});

test("R-metrics-086: watch rows fold to one group and install rows to one, last", () => {
  const w = (repo, n) => fnd(repo, `watch.x${n}`, { kind: "watch", id: `repo.watch.x${n}` });
  const i = (repo) => fnd(repo, "install.k", { kind: "install", id: "repo.install.k", weight: "finding" });
  const roll = repoRollup([r("a", res([w("a", 1), w("a", 2), i("a")])), r("b", res([w("b", 1)]))]);
  assert.deepEqual(roll.groups.map((g) => g.rule), ["watch", "install"]);
  assert.equal(roll.groups[0].repos.find((x) => x.repoId === "a").findingIds.length, 2);
  assert.equal(groupRuleOf(w("a", 1)), "watch");
});

test("R-metrics-087: counted findings first, then saving; repos in a group by saving, absent last; no total", () => {
  const roll = repoRollup([
    r("a", res([fnd("a", "cheap", { saving: sv(1) }), fnd("a", "big", { saving: sv(9) }), fnd("a", "counted", { weight: "finding" }), fnd("a", "shared")])),
    r("b", res([fnd("b", "shared", { saving: sv(5) })])),
    r("c", res([fnd("c", "shared", { saving: sv(7) })])),
  ]);
  assert.deepEqual(roll.groups.map((g) => g.rule), ["counted", "big", "shared", "cheap"]);
  assert.deepEqual(roll.groups.find((g) => g.rule === "shared").repos.map((x) => x.repoId), ["c", "b", "a"]);
  const keys = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, p + k + ".") : [p + k]));
  assert.ok(!keys(roll).some((k) => /total|sum|score/i.test(k)));
});

test("R-metrics-086: machine, account and waived findings never enter", () => {
  const roll = repoRollup([r("a", res([
    fnd("a", "m", { scope: "machine" }), fnd("a", "acc", { scope: "account" }),
    fnd("a", "w", { waive: { via: "ignore", waived: { at: "x" } } }),
  ], [pass("a", "w")]))]);
  assert.equal(roll.groups.length, 0);
  assert.equal(roll.clear.length, 1);
});
