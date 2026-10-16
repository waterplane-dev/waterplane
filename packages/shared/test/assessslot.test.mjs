// The slot check's two proposal kinds (`shared/src/assess/*`, 2026-10-16):
// `conflict` is words and never a mutation; `split` posts two texts in place
// of one row and is refused if it would lose a file path the row named.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAssessment, assessConflictSentence, assessSplitReason, cleanAssessScope, cleanAssessment, cleanIntentRow,
} from "../dist/index.js";

const items = [
  { id: "a", source: "intent", text: "bump the version to 2.0", state: "queued" },
  { id: "b", source: "intent", text: "revert the version bump", state: "queued" },
  { id: "c", source: "intent", text: "fix .claude/inbox/crash.png and then update the README", state: "queued" },
  { id: "n", source: "note", text: "write tests and docs" },
  { id: "ctx", source: "intent", text: "finished thing", state: "done", context: true },
];

test("a conflict keeps its known ids and its sentence", () => {
  const p = cleanAssessment({ rows: [], conflicts: [{ cid: "c1", ids: ["a", "b"], why: "one bumps the version, the other reverts it" }] }, items);
  assert.deepEqual(p.conflicts, [{ cid: "c1", ids: ["a", "b"], why: "one bumps the version, the other reverts it" }]);
  assert.equal(assessConflictSentence(p.conflicts[0]), "these two contradict each other — one bumps the version, the other reverts it");
});

test("a conflict drops unknown and context ids, and needs two known ids and a reason", () => {
  const p = cleanAssessment({
    conflicts: [
      { cid: "x", ids: ["a", "ghost", "b"], why: "w" },
      { cid: "y", ids: ["a", "ghost"], why: "w" },
      { cid: "z", ids: ["a", "ctx"], why: "w" },
      { cid: "q", ids: ["a", "c"] },
      { cid: "dup", ids: ["b", "a"], why: "same pair again" },
    ],
  }, items);
  assert.deepEqual(p.conflicts.map((c) => [c.cid, c.ids]), [["x", ["a", "b"]]]);
  assert.ok(p.notes.some((n) => n.includes("“y”") && n.includes("fewer than two")));
  assert.ok(p.notes.some((n) => n.includes("“q”") && n.includes("did not say")));
  assert.ok(p.notes.some((n) => n.includes("“dup”")));
});

test("a proposal with no conflicts or splits keeps the old shape", () => {
  const p = cleanAssessment({ rows: [] }, items);
  assert.equal("conflicts" in p, false);
  assert.equal("splits" in p, false);
});

test("conflicts are never a mutation, whatever the choices say", () => {
  const p = cleanAssessment({ conflicts: [{ cid: "c1", ids: ["a", "b"], why: "w" }] }, items);
  const m = applyAssessment(p, { rows: ["a", "b"], merges: ["c1"], splits: ["c1"] }, { runId: "r", items });
  assert.deepEqual(m.dismiss, []);
  assert.deepEqual(m.post, []);
  assert.deepEqual(m.split, []);
});

test("a split that keeps every path is kept", () => {
  const p = cleanAssessment({
    splits: [{ sid: "s1", id: "c", texts: ["fix the crash in .claude/inbox/crash.png", "update the README"], rationale: "a fix and a docs change" }],
  }, items);
  assert.deepEqual(p.splits, [{ sid: "s1", id: "c", texts: ["fix the crash in .claude/inbox/crash.png", "update the README"], rationale: "a fix and a docs change" }]);
});

test("a split that loses a path is refused, never repaired", () => {
  const p = cleanAssessment({ splits: [{ sid: "s1", id: "c", texts: ["fix the crash", "update the README"] }] }, items);
  assert.equal(p.splits, undefined);
  assert.ok(p.notes.some((n) => n.includes(".claude/inbox/crash.png") && n.includes("refused")));
});

test("a split needs exactly two different, non-empty texts that are not the original", () => {
  const bad = [
    { sid: "one", id: "a", texts: ["only one"] },
    { sid: "three", id: "a", texts: ["x", "y", "z"] },
    { sid: "empty", id: "a", texts: ["x", "  "] },
    { sid: "same", id: "a", texts: ["x", "x"] },
    { sid: "orig", id: "a", texts: ["bump the version to 2.0", "and more"] },
    { sid: "huge", id: "a", texts: ["x".repeat(20_001), "y"] },
  ];
  for (const s of bad) {
    const p = cleanAssessment({ splits: [s] }, items);
    assert.equal(p.splits, undefined, s.sid);
    assert.ok(p.notes.some((n) => n.includes(`“${s.sid}”`)), s.sid);
  }
});

test("a split is refused on an unknown id, a context row, a pad note, or a row another outcome retires", () => {
  const cases = [
    { splits: [{ sid: "s", id: "ghost", texts: ["x", "y"] }] },
    { splits: [{ sid: "s", id: "ctx", texts: ["x", "y"] }] },
    { splits: [{ sid: "s", id: "n", texts: ["write tests", "write docs"] }] },
    { rows: [{ id: "a", verdict: "done", evidence: "src/v.ts:1" }], splits: [{ sid: "s", id: "a", texts: ["x", "y"] }] },
    { merges: [{ gid: "g", ids: ["a", "b"], prompt: "settle the version", rationale: "r" }], splits: [{ sid: "s", id: "a", texts: ["x", "y"] }] },
  ];
  for (const doc of cases) assert.equal(cleanAssessment(doc, items).splits, undefined, JSON.stringify(doc));
});

test("two splits of one row are two answers, so neither is used", () => {
  const p = cleanAssessment({ splits: [{ sid: "s1", id: "a", texts: ["x", "y"] }, { sid: "s2", id: "a", texts: ["p", "q"] }, { sid: "s3", id: "b", texts: ["p", "q"] }] }, items);
  assert.deepEqual(p.splits.map((s) => s.sid), ["s3"]);
  assert.ok(p.notes.some((n) => n.includes("“a”") && n.includes("more than one way")));
});

test("an approved split posts both texts and replaces the row's own verdict", () => {
  const p = cleanAssessment({
    rows: [{ id: "a", verdict: "wanted", evidence: "", rank: 1 }],
    splits: [{ sid: "s1", id: "a", texts: ["bump to 2.0", "tag the release"], rationale: "two steps" }],
  }, items);
  const none = applyAssessment(p, { rows: ["a"] }, { runId: "r1", items });
  assert.deepEqual(none.split, []);
  assert.deepEqual(none.rank, [{ id: "a", rank: 1 }]);
  const m = applyAssessment(p, { rows: ["a"], splits: ["s1"] }, { runId: "r1", items });
  assert.deepEqual(m.split, [{ sid: "s1", id: "a", texts: ["bump to 2.0", "tag the release"], origin: "assess:r1", rationale: "two steps" }]);
  assert.deepEqual(m.rank, []);
  assert.deepEqual(m.dismiss, []);
  assert.equal(assessSplitReason("two steps", ["x", "y"]), "split into x and y — two steps");
});

test("the slot scope: one shape survives the wire and the disk, anything else is dropped", () => {
  assert.deepEqual(cleanAssessScope({ kind: "slot", key: " reset:session:5 " }), { kind: "slot", key: "reset:session:5" });
  for (const v of [null, {}, { kind: "repo", key: "k" }, { kind: "slot" }, { kind: "slot", key: "" }]) assert.equal(cleanAssessScope(v), undefined);
  const row = (payload) => cleanIntentRow({
    id: "r", origin: "assess", createdAt: 1, state: "queued", attempts: 0,
    target: { kind: "shell", cwd: "/r" }, trigger: { kind: "now" }, payload, cwd: "/r",
  });
  assert.deepEqual(row({ kind: "assess", ids: ["a"], scope: { kind: "slot", key: "at:5" } })?.payload, { kind: "assess", ids: ["a"], scope: { kind: "slot", key: "at:5" } });
  // A scope with nothing to scope is dropped with the ids it would have named.
  assert.deepEqual(row({ kind: "assess", scope: { kind: "slot", key: "at:5" } })?.payload, { kind: "assess" });
});
