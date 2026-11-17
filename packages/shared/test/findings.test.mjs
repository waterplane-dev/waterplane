/** Findings: rank, cut, saving, words, checked-off list. node --test packages/shared/test/findings.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { rankFindings, findingCut, checkedCut, checkedOffOf, weekSavingOf, savingWords, moneyLabel, checkedCountWords, passedWords, SETUP_COST_MIN_N } from "../dist/index.js";

const be = { understood: ["claude"], unread: [] };
const F = (id, o = {}) => ({ id, rule: id, scope: "repo", repo: "r", kind: "cost", weight: "consider", what: id, backends: be, evidence: null, remedy: { kind: "howto", text: "x" }, waive: { via: "none" }, ...o });

test("rank: unwaived, finding before consider, usd, tokens, kind, id", () => {
  const list = [
    F("e", { kind: "install" }), F("d", { kind: "quality" }), F("c", { saving: { tokens: 5, per: "week", basis: "measured", errs: null } }),
    F("b", { saving: { usd: 2, per: "week", basis: "measured", errs: null } }), F("a", { saving: { usd: 9, per: "week", basis: "measured", errs: null } }),
    F("w", { weight: "finding", kind: "install" }), F("z", { waive: { via: "ignore", waived: { at: "t" } }, weight: "finding" }),
  ];
  assert.deepEqual(rankFindings(list).map((f) => f.id), ["w", "a", "b", "c", "d", "e", "z"]);
});

test("cut: rows and count are one answer; waived are not findings", () => {
  const list = [F("a"), F("b", { weight: "finding" }), F("c", { scope: "machine", repo: undefined }), F("d", { waive: { via: "ignore", waived: { at: "t" } } })];
  for (const o of [{}, { scope: "repo" }, { weight: "finding" }, { repo: "r" }]) {
    const c = findingCut(list, o);
    assert.equal(c.count, c.rows.length);
  }
  assert.equal(findingCut(list).count, 3);
  assert.equal(findingCut(list, { scope: "repo", weight: "finding" }).count, 1);
});

test("checked-off list: waived moves there, labelled; notChecked is never passed", () => {
  const r = checkedOffOf({ findings: [F("a"), F("d", { waive: { via: "ignore", waived: { at: "t", reason: "on purpose" } } })], passed: [], notChecked: [{ rule: "x", scope: "repo", why: "othercli not read" }] }, 1);
  assert.deepEqual(r.findings.map((f) => f.id), ["a"]);
  assert.equal(r.passed.length, 1);
  assert.equal(r.passed[0].waived, "waived: on purpose");
  assert.match(passedWords(r.passed[0]), /waived: on purpose/);
  assert.equal(checkedCut(r, { scope: "machine" }).passed.length, 0);
  assert.equal(r.notChecked.length, 1);
  assert.equal(checkedCountWords(0, 3, 1), "0 findings · 3 checks passed · 1 not checked");
  assert.equal(checkedCountWords(1, 1, 0), "1 finding · 1 check passed");
  // Under a cut's own "n of N findings" bar the head does not say the findings again.
  assert.equal(checkedCountWords(1, 1, 0, true), "1 check passed");
  assert.equal(checkedCountWords(1, 2, 3, true), "2 checks passed · 3 not checked");
});

const now = Date.parse("2026-11-16T12:00:00Z");
const pt = (i, o = {}) => ({ id: "s" + i, t0: now - (i + 1) * 3600e3 * 5, repo: "r", fresh: true, headless: false, model: "claude-sonnet-4-5", start: 20000, req: 10, ...o });

test("saving: absent under the minimum", () => {
  const pts = Array.from({ length: SETUP_COST_MIN_N - 1 }, (_, i) => pt(i));
  assert.ok("absent" in weekSavingOf(pts, { now, extraTok: 1000 }));
});

test("saving: measured has no estimate sign; chars are an estimate; unpriced stay out of usd", () => {
  const pts = Array.from({ length: SETUP_COST_MIN_N }, (_, i) => pt(i));
  const m = weekSavingOf(pts, { now, extraTok: 1000 });
  assert.equal(m.basis, "measured");
  assert.equal(m.tokens, Math.round(1000 * 10 * SETUP_COST_MIN_N * 0.5));
  assert.ok(m.usd > 0);
  assert.ok(!savingWords(m).includes("≈"));
  const e = weekSavingOf(pts, { now, extraChars: 4000 });
  assert.equal(e.basis, "estimate");
  assert.equal(e.tokens, m.tokens);
  assert.ok(savingWords(e).includes("≈"));
  const mixed = pts.map((p, i) => (i < 3 ? { ...p, model: "mystery-model" } : p));
  const u = weekSavingOf(mixed, { now, extraTok: 1000 });
  assert.equal(u.unpricedSessions, 3);
  assert.equal(u.tokens, m.tokens);
  assert.ok(u.usd < m.usd);
  const none = weekSavingOf(pts.map((p) => ({ ...p, model: "mystery-model" })), { now, extraTok: 1000 });
  assert.equal(none.usd, undefined);
  assert.ok(none.tokens > 0);
});

test("money label by billing profile", () => {
  assert.match(moneyLabel("subscription", "S"), /at list price, not a bill/);
  assert.match(moneyLabel("unknown", "S"), /not a bill/);
  assert.ok(!/not a bill/.test(moneyLabel("api", "S")));
  assert.ok(!/not a bill/.test(moneyLabel("cloud", "S")));
});

test("the backends line is one short line with display names, the reasons are a separate sentence", async () => {
  const { backendsWords, backendsWhy } = await import("../dist/index.js");
  const b = { understood: ["claude"], unread: [{ id: "other", why: "its store is not read" }, { id: "copilot", why: "its store is not read" }, { id: "codex", why: "x" }, { id: "gemini", why: "y" }] };
  assert.equal(backendsWords(b), "read: Claude Code · not read: Other, Copilot, Codex, Gemini");
  assert.match(backendsWhy(b), /^Other: its store is not read\. Copilot:/);
  assert.equal(backendsWords({ understood: ["claude"], unread: [] }), "read: Claude Code");
  // A backend a plugin added: the desktop's own label wins; with none sent the id is capitalised, never printed raw.
  const oc = { understood: ["claude"], unread: [{ id: "acme", why: "z" }] };
  assert.equal(backendsWords(oc, { acme: "ACME Agent" }), "read: Claude Code · not read: ACME Agent");
  assert.equal(backendsWords(oc), "read: Claude Code · not read: Acme");
});
