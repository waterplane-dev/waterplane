// The rules that stand between a two-second grooming pass and a backlog it
// quietly rewrote (`shared/src/smartpick.ts`).
//
// The feature is three verbs — pick which item runs next, merge items that are
// one job, sort the rest — applied AUTOMATICALLY, with no approval step. The
// user chose that with the trade-off in view, so the safety is not a screen
// somebody looks at: it is every assertion below.
//
// Which is why the shape of this file is "what the pass is refused". An id that
// is not in the backlog is dropped and never spawned. An item the model forgot
// keeps its place. A merge whose text loses `.claude/inbox/foo.png` is dropped
// with the path named, because a merged prompt that points at a file it no
// longer names is a prompt that will fail in a session nobody is watching. A
// row a person DRAGGED is never moved by any of it. And every way a pass can
// fail ends on the same sentence — "fired in the order you had" — which is the
// whole promise: a pass that goes wrong costs a few seconds and changes
// nothing.
//
// Pure, so all of it runs from literals with no host, nothing spawned, and no
// `packages/host/dist` in existence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MERGE_SIZE,
  MAX_SMARTPICK_MERGES,
  SMARTPICK_MAX_NOTES,
  SMARTPICK_NOOP_TEXT,
  SMARTPICK_OUTCOMES,
  SMARTPICK_UNREADABLE,
  applySmartPick,
  cleanSmartPick,
  fingerprint,
  imagePaths,
  mergeKey,
  smartpickFingerprint,
  smartpickName,
  smartpickOutcomeText,
  transportPaths,
} from "../dist/index.js";

const cand = (id, over = {}) => ({ id, text: `words for ${id}`, order: 0, steps: 1, ...over });
/** N candidates, slots ten apart — the host's own values, never 0..n. */
const cands = (...ids) => ids.map((id, i) => cand(id, { order: (i + 1) * 10 }));
const answer = (o) => JSON.stringify(o);
const facts = (over = {}) => ({ branch: "main", dirty: ["M src/a.ts"], commits: ["Wire it up"], ...over });

// ── Reading whatever the model actually wrote ────────────────────────────────

test("a fenced answer is unwrapped, and so is one with prose either side", () => {
  const list = cands("a", "b");
  const body = answer({ pick: "b", order: ["b", "a"], merges: [], why: "b is smaller" });

  for (const raw of [
    body,
    "```json\n" + body + "\n```",
    "Here is the grooming plan:\n\n" + body + "\n\nLet me know if you want it different.",
  ]) {
    const p = cleanSmartPick(raw, list);
    assert.ok(p, `no proposal from: ${raw.slice(0, 30)}`);
    assert.equal(p.pick, "b");
    assert.deepEqual(p.order, ["b", "a"]);
    assert.equal(p.why, "b is smaller");
  }
});

test("nothing readable is null — the caller records `failed` and the item fires anyway", () => {
  for (const raw of ["", "   ", "I could not decide.", "[1, 2, 3]", "```\nnot json\n```"]) {
    assert.equal(cleanSmartPick(raw, cands("a", "b")), null, `expected null from: ${JSON.stringify(raw)}`);
  }
  // And the sentence that gets recorded for it is this module's, not the host's.
  assert.match(smartpickOutcomeText({ outcome: "failed", merged: 0, sorted: 0, durationMs: 90 }), new RegExp(SMARTPICK_UNREADABLE));
});

test("an id that is not in this backlog is dropped, never spawned", () => {
  const p = cleanSmartPick(answer({ pick: "a", order: ["a", "ghost", "b"] }), cands("a", "b"));
  assert.deepEqual(p.order, ["a", "b"]);
  assert.ok(p.notes.some((n) => n.includes("not in this backlog")), p.notes.join(" | "));
});

test("an item the model left out keeps its place — silence is not a decision", () => {
  const p = cleanSmartPick(answer({ order: ["c"] }), cands("a", "b", "c"));
  // c was named; a and b were not, so they come back in the order they had.
  assert.deepEqual(p.order, ["a", "b", "c"]);
  assert.ok(p.notes.some((n) => n.includes("left out of the order")), p.notes.join(" | "));
});

test("an id listed twice keeps its first place", () => {
  const p = cleanSmartPick(answer({ order: ["b", "a", "b"] }), cands("a", "b"));
  assert.deepEqual(p.order, ["b", "a"]);
  assert.ok(p.notes.some((n) => n.includes("listed twice")), p.notes.join(" | "));
});

test("a merge group that names one item twice has not named a missing one", () => {
  // `["a","a","b"]` dedupes to two known items and nothing is lost — but the
  // count was taken against the RAW list, so the note read "named 1 item(s)
  // that are not in this backlog" about a backlog holding both: a sentence that
  // sends somebody looking for a third item that never existed.
  const p = cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "a", "b"], text: "both", why: "one job" }],
  }), cands("a", "b"));
  assert.equal(p.merges.length, 1, "the group itself survives — a repeat is not a claim");
  assert.deepEqual(p.merges[0].ids, ["a", "b"]);
  assert.equal(p.notes.filter((n) => n.includes("not in this backlog")).length, 0, p.notes.join(" | "));
  // A genuinely unknown id in the same shape is still reported, once.
  const ghost = cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "a", "b", "ghost"], text: "both", why: "one job" }],
  }), cands("a", "b"));
  assert.ok(ghost.notes.some((n) => n.includes("named 1 item(s) that are not in this backlog")), ghost.notes.join(" | "));
});

test("a pick that names nothing in the backlog falls back to the first of the order", () => {
  const p = cleanSmartPick(answer({ pick: "ghost", order: ["b", "a"] }), cands("a", "b"));
  assert.equal(p.pick, "b");
  assert.ok(p.notes.some((n) => n.includes("“ghost”")), p.notes.join(" | "));
});

test("a pick naming a merged-away member is read as the group it went into", () => {
  const list = cands("a", "b", "c");
  const p = cleanSmartPick(answer({
    pick: "b",
    order: ["a", "b", "c"],
    merges: [{ ids: ["a", "b"], text: "do both", why: "one job" }],
  }), list);
  assert.equal(p.pick, mergeKey(0));
  assert.deepEqual(p.order, [mergeKey(0), "c"]);
});

// ── Every condition a merge has to survive ───────────────────────────────────

test("a merge of one is a rewrite of your sentence, not a merge", () => {
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges: [{ ids: ["a"], text: "just a", why: "" }] }), cands("a", "b"));
  assert.deepEqual(p.merges, []);
  assert.deepEqual(p.order, ["a", "b"]);
  assert.ok(p.notes.some((n) => n.includes("fewer than 2")), p.notes.join(" | "));
});

test(`a merge over ${MAX_MERGE_SIZE} is dropped and its items keep their own words`, () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const p = cleanSmartPick(answer({ order: ids, merges: [{ ids, text: "everything", why: "all one" }] }), cands(...ids));
  assert.deepEqual(p.merges, []);
  assert.deepEqual(p.order, ids);
  assert.ok(p.notes.some((n) => n.includes(`over the limit of ${MAX_MERGE_SIZE}`)), p.notes.join(" | "));
});

test("two groups claiming the same item — the second is dropped, not half-applied", () => {
  const p = cleanSmartPick(answer({
    order: ["a", "b", "c"],
    merges: [
      { ids: ["a", "b"], text: "a and b", why: "one job" },
      { ids: ["b", "c"], text: "b and c", why: "also one job" },
    ],
  }), cands("a", "b", "c"));
  assert.equal(p.merges.length, 1);
  assert.deepEqual(p.merges[0].ids, ["a", "b"]);
  assert.deepEqual(p.order, [mergeKey(0), "c"]);
  assert.ok(p.notes.some((n) => n.includes("another merge already took")), p.notes.join(" | "));
});

test("a clipped member is refused — a merge folds words the pass never read", () => {
  const list = [cand("a", { order: 10 }), cand("b", { order: 20, clipped: true })];
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }] }), list);
  assert.deepEqual(p.merges, []);
  assert.ok(p.notes.some((n) => n.includes("first few lines")), p.notes.join(" | "));
});

test("a chain cannot be folded into one prompt", () => {
  const list = [cand("a", { order: 10 }), cand("b", { order: 20, steps: 3 })];
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }] }), list);
  assert.deepEqual(p.merges, []);
  assert.ok(p.notes.some((n) => n.includes("3-step")), p.notes.join(" | "));
});

test("members that disagree about `resume` are refused — the merged row can only do one", () => {
  const list = [cand("a", { order: 10, resume: true }), cand("b", { order: 20 })];
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }] }), list);
  assert.deepEqual(p.merges, []);
  assert.ok(p.notes.some((n) => n.includes("start clean")), p.notes.join(" | "));

  // Agreeing on it is fine, and the agreement survives into the plan.
  const ok = cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: "both", why: "one job" }],
  }), [cand("a", { order: 10, resume: true }), cand("b", { order: 20, resume: true })]);
  assert.equal(ok.merges.length, 1);
});

test("a merged text that drops one of two inbox paths is dropped, and the note names the path", () => {
  const list = [
    cand("a", { order: 10, text: "annotate .claude/inbox/one.png and file it" }),
    cand("b", { order: 20, text: "compare it with .claude/inbox/two.png" }),
  ];
  const p = cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: "annotate .claude/inbox/one.png and compare the two shots", why: "one job" }],
  }), list);
  assert.deepEqual(p.merges, [], "a merge that loses a file must not survive");
  assert.ok(p.notes.some((n) => n.includes(".claude/inbox/two.png")), p.notes.join(" | "));

  // Keeping both is all that is asked: no length rule, no wording rule.
  const ok = cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: "annotate .claude/inbox/one.png, then compare it with .claude/inbox/two.png", why: "one job" }],
  }), list);
  assert.equal(ok.merges.length, 1);
});

test("a SPACED filename is checked by name, not by the regex's guess at it", () => {
  // The hole the regex had: `safeName` keeps spaces and macOS names its own
  // screenshots with three of them. `TRANSPORT_RE` is `\S+`, so
  // `.claude/inbox/Screenshot 2026-09-17 at 10.00.00.png` read as the fragment
  // `.claude/inbox/Screenshot` plus a stray `10.00.00.png` — and a merged text
  // that "tidied" the name to `Screenshot_2026-09-17.png` contains BOTH
  // fragments, so the merge survived the one check it must never survive and
  // the merged item told an agent to open a file that does not exist.
  //
  // Only the host can know the real names, and `paths` is it saying so.
  const NAME = ".claude/inbox/Screenshot 2026-09-17 at 10.00.00.png";
  const list = [
    cand("a", { order: 10, text: `annotate ${NAME}`, paths: [NAME] }),
    cand("b", { order: 20, text: "and write the caption" }),
  ];
  const renamed = cleanSmartPick(answer({
    order: ["a", "b"],
    // The rename a model actually writes: the spaces closed up. Every fragment
    // the regex asked for is still a SUBSTRING of it — `.claude/inbox/Screenshot`
    // and `10.00.00.png` both survive the tidy — which is why the group used to
    // pass the check while naming a file that does not exist.
    merges: [{ ids: ["a", "b"], text: "annotate .claude/inbox/Screenshot_2026-09-17_at_10.00.00.png and caption it", why: "one job" }],
  }), list);
  assert.deepEqual(renamed.merges, [], "a merge that renames a file must not survive");
  assert.ok(renamed.notes.some((n) => n.includes(NAME)), renamed.notes.join(" | "));

  // Keeping the name whole is all that is asked — the same rule as every other
  // path, now applied to the name as it is spelled on disk.
  const kept = cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: `annotate ${NAME} and caption it`, why: "one job" }],
  }), list);
  assert.equal(kept.merges.length, 1);

  // Absent ⇒ the regex alone, which is what every candidate built before this
  // field carries: unchanged behaviour, never a new refusal.
  const noPaths = [cand("a", { order: 10, text: "annotate .claude/inbox/one.png" }), cand("b", { order: 20, text: "caption it" })];
  assert.equal(cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: "annotate .claude/inbox/one.png and caption it", why: "one job" }],
  }), noPaths).merges.length, 1);

  // And the field may only ever TIGHTEN the check: a path the member's own
  // words do not contain is dropped, never demanded of the merged text.
  const overclaimed = [
    cand("a", { order: 10, text: "no files here at all", paths: [".claude/inbox/ghost.png"] }),
    cand("b", { order: 20, text: "nor here" }),
  ];
  assert.equal(cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: "one job, no files", why: "one job" }],
  }), overclaimed).merges.length, 1);
});

test("a path in markdown is checked without its markup", () => {
  // Prompts are written in markdown, so `` `.claude/inbox/a.png` `` and
  // `**a.png**` carried their fences into the path and the check then demanded
  // that the MARKUP survive the merge. Safe (nothing is lost) but permanent:
  // the same group dropped on every pass, with a note naming a file the merged
  // text does in fact name.
  assert.deepEqual(transportPaths("see `.claude/inbox/a.png`"), [".claude/inbox/a.png"]);
  assert.deepEqual(imagePaths("**docs/flow.png**"), ["docs/flow.png"]);
  const list = [
    cand("a", { order: 10, text: "annotate `.claude/inbox/a.png`" }),
    cand("b", { order: 20, text: "caption it" }),
  ];
  assert.equal(cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: "annotate .claude/inbox/a.png and caption it", why: "one job" }],
  }), list).merges.length, 1);
});

test("an image path outside the transport counts too — it is a file either way", () => {
  const list = [cand("a", { order: 10, text: "redraw docs/flow.png" }), cand("b", { order: 20, text: "and the caption" })];
  const p = cleanSmartPick(answer({
    order: ["a", "b"],
    merges: [{ ids: ["a", "b"], text: "redraw the diagram and its caption", why: "one job" }],
  }), list);
  assert.deepEqual(p.merges, []);
  assert.ok(p.notes.some((n) => n.includes("docs/flow.png")), p.notes.join(" | "));
});

test("a merge with no text is dropped", () => {
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges: [{ ids: ["a", "b"], why: "one job" }] }), cands("a", "b"));
  assert.deepEqual(p.merges, []);
  assert.ok(p.notes.some((n) => n.includes("no text")), p.notes.join(" | "));
});

test("a merge a person already undid is not proposed again", () => {
  const list = cands("a", "b", "c");
  const body = answer({ order: ["a", "b", "c"], merges: [{ ids: ["b", "a"], text: "both", why: "one job" }] });
  assert.equal(cleanSmartPick(body, list).merges.length, 1, "with no refusals it stands");
  // The refusal is stored sorted; the model may name them in any order.
  const p = cleanSmartPick(body, list, [["a", "b"]]);
  assert.deepEqual(p.merges, []);
  assert.ok(p.notes.some((n) => n.includes("already undid")), p.notes.join(" | "));
  // A DIFFERENT set is a different proposal and is allowed through.
  assert.equal(cleanSmartPick(body, list, [["a", "c"]]).merges.length, 1);
});

test(`no more than ${MAX_SMARTPICK_MERGES} groups survive one pass`, () => {
  const ids = Array.from({ length: 24 }, (_, i) => `i${i}`);
  const merges = [];
  for (let i = 0; i < 12; i++) merges.push({ ids: [ids[i * 2], ids[i * 2 + 1]], text: `job ${i}`, why: "one job" });
  const p = cleanSmartPick(answer({ order: ids, merges }), cands(...ids));
  assert.equal(p.merges.length, MAX_SMARTPICK_MERGES);
  assert.ok(p.notes.some((n) => n.includes(`first ${MAX_SMARTPICK_MERGES}`)), p.notes.join(" | "));
});

test("notes are capped — the strip is read by a person, not tailed", () => {
  const list = cands("a", "b");
  const merges = Array.from({ length: 25 }, () => ({ ids: ["a"], text: "solo", why: "" }));
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges }), list);
  assert.equal(p.notes.length, SMARTPICK_MAX_NOTES);
});

test("aliases: `sorted`/`prompt`/`rationale` are read, because refusing over spelling costs a second pass", () => {
  const p = cleanSmartPick(answer({
    next: "b",
    sorted: ["b", "a"],
    merge: [{ ids: ["a", "b"], prompt: "both of them", rationale: "one job" }],
    reason: "b first",
  }), cands("a", "b"));
  assert.equal(p.merges.length, 1);
  assert.equal(p.merges[0].text, "both of them");
  assert.equal(p.merges[0].why, "one job");
  assert.equal(p.why, "b first");
  assert.equal(p.pick, mergeKey(0));
});

// ── The file rule, on its own ────────────────────────────────────────────────

test("transportPaths finds inbox/outbox paths and images, trailing punctuation off", () => {
  assert.deepEqual(
    transportPaths("look at .claude/outbox/flow.gif, then docs/a.png."),
    [".claude/outbox/flow.gif", "docs/a.png"],
  );
  assert.deepEqual(imagePaths("no files here"), []);
  // An inbox file that is not an image still has to survive a merge.
  assert.deepEqual(transportPaths("read .claude/inbox/log.txt"), [".claude/inbox/log.txt"]);
});

// ── Turning a proposal into a plan ───────────────────────────────────────────

const proposal = (over = {}) => ({ pick: null, order: [], merges: [], why: "", notes: [], ...over });

test("the sort re-assigns the slot VALUES the rows already had, never 0..n", () => {
  const list = cands("a", "b", "c");                 // slots 10, 20, 30
  const plan = applySmartPick(proposal({ order: ["c", "a", "b"] }), list);
  assert.deepEqual(
    plan.orders.slice().sort((x, y) => x.order - y.order),
    [{ id: "c", order: 10 }, { id: "a", order: 20 }, { id: "b", order: 30 }],
  );
});

test("a row you dragged keeps its slot, and the machine sorts around it", () => {
  const list = [cand("a", { order: 10, handOrdered: true }), cand("b", { order: 20 }), cand("c", { order: 30 })];
  const plan = applySmartPick(proposal({ order: ["c", "b", "a"], pick: "c" }), list);
  assert.equal(plan.orders.find((o) => o.id === "a"), undefined, "the hand-placed row must not be touched");
  assert.deepEqual(
    plan.orders.slice().sort((x, y) => x.order - y.order),
    [{ id: "c", order: 20 }, { id: "b", order: 30 }],
  );
  assert.ok(
    plan.notes.some((n) => n.includes("you had placed “words for a” first")),
    plan.notes.join(" | "),
  );
});

test("the pick takes the first slot the machine is allowed to fill", () => {
  const list = cands("a", "b", "c");
  const plan = applySmartPick(proposal({ order: ["a", "b", "c"], pick: "c" }), list);
  assert.equal(plan.orders.find((o) => o.id === "c").order, 10);
});

test("a repo where you placed everything by hand gets no order mutations at all", () => {
  const list = ["a", "b", "c"].map((id, i) => cand(id, { order: (i + 1) * 10, handOrdered: true }));
  const plan = applySmartPick(proposal({ order: ["c", "b", "a"], pick: "c" }), list);
  assert.deepEqual(plan.orders, []);
  assert.ok(plan.notes.some((n) => n.includes("placed by hand")), plan.notes.join(" | "));
});

test("a merged row takes the earliest member's slot and inherits `handOrdered`", () => {
  const list = [cand("a", { order: 10 }), cand("b", { order: 20, handOrdered: true }), cand("c", { order: 30 })];
  const plan = applySmartPick(proposal({
    order: [mergeKey(0), "c"],
    merges: [{ ids: ["a", "b"], text: "both", why: "one job" }],
  }), list);
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].order, 10, "the earliest member's slot");
  assert.equal(plan.merges[0].handOrdered, true, "a hand-placed member makes the merged row hand-placed");
  assert.deepEqual(plan.merges[0].ids, ["a", "b"]);
  // The freed slot goes to the only machine row left.
  assert.deepEqual(plan.orders, [{ id: "c", order: 20 }]);
});

test("two rows sharing one slot value each get one slot back", () => {
  // The slots are the candidates' OWN `order` values, taken as a multiset and
  // re-assigned — never renumbered 0..n, so rows in the repo that are not
  // candidates keep their relative places. Two rows that happen to share a
  // value (a schedule and a hand-post landing on the same number) are therefore
  // two entries, and a pinned one may only eat ONE of them: the code removes a
  // single occurrence, and this is what says so.
  const list = [cand("a", { order: 10, handOrdered: true }), cand("b", { order: 10 }), cand("c", { order: 20 })];
  const plan = applySmartPick(proposal({ order: ["c", "b", "a"] }), list);
  const slots = [...plan.orders.map((o) => o.order), 10].sort((x, y) => x - y);
  assert.deepEqual(slots, [10, 10, 20], "the same three values come back out");
  // `a` is pinned at 10 and is not in `orders` at all; the machine rows take
  // what is left, in the order the pass asked for.
  assert.deepEqual(plan.orders, [{ id: "c", order: 10 }, { id: "b", order: 20 }]);
});

test("an UNPINNED merged group takes the next machine slot, not its earliest member's", () => {
  // The header, the plan's comment and the plan document all described the
  // pinned case as though it were the rule, and the test above only passed
  // because member `b` was `handOrdered`. With nobody pinned, a merged group is
  // one entity in the machine's sequence like any other and lands wherever the
  // sanitised order puts it — which is how a merge can move work LATER, and is
  // ordinary rather than a bug.
  const list = [cand("a", { order: 10 }), cand("b", { order: 20 }), cand("c", { order: 30 })];
  const plan = applySmartPick(proposal({
    order: ["c", mergeKey(0)],
    merges: [{ ids: ["a", "b"], text: "both", why: "one job" }],
  }), list);
  assert.equal(plan.merges[0].order, 20, "the second machine slot — not member a's 10");
  assert.equal("handOrdered" in plan.merges[0], false);
  assert.deepEqual(plan.orders, [{ id: "c", order: 10 }]);
  // The slot multiset is the candidates' own values, re-assigned: 30 is not
  // handed out at all, because two entities are sharing three slots.
  assert.ok(![...plan.orders.map((o) => o.order), plan.merges[0].order].includes(30));
});

test("a merged row carries the `resume` its members agreed on, and nothing when they had none", () => {
  const yes = [cand("a", { order: 10, resume: true }), cand("b", { order: 20, resume: true })];
  const planYes = applySmartPick(proposal({ order: [mergeKey(0)], merges: [{ ids: ["a", "b"], text: "x", why: "" }] }), yes);
  assert.equal(planYes.merges[0].resume, true);

  const no = cands("a", "b");
  const planNo = applySmartPick(proposal({ order: [mergeKey(0)], merges: [{ ids: ["a", "b"], text: "x", why: "" }] }), no);
  assert.equal("resume" in planNo.merges[0], false, "absent, never `false` — the host reads absence as start clean");
});

test("a row already in the right place is not a mutation, so `sorted N` is honest", () => {
  const list = cands("a", "b", "c");
  const plan = applySmartPick(proposal({ order: ["a", "b", "c"] }), list);
  assert.deepEqual(plan.orders, []);
});

// ── The fingerprint ──────────────────────────────────────────────────────────

test("the same backlog and the same repo hash the same, every time", () => {
  const list = cands("a", "b");
  assert.equal(smartpickFingerprint(list, facts()), smartpickFingerprint(cands("a", "b"), facts()));
  assert.match(fingerprint("anything"), /^[0-9a-f]{16}$/);
});

test("a drag, an edit, a commit, a dirty file, a re-order — each one moves the fingerprint", () => {
  const base = smartpickFingerprint(cands("a", "b"), facts());
  const moved = [
    ["a drag", smartpickFingerprint([cand("a", { order: 10, handOrdered: true }), cand("b", { order: 20 })], facts())],
    ["an edit", smartpickFingerprint([cand("a", { order: 10, text: "new words" }), cand("b", { order: 20 })], facts())],
    ["a new slot", smartpickFingerprint([cand("a", { order: 5 }), cand("b", { order: 20 })], facts())],
    ["a commit", smartpickFingerprint(cands("a", "b"), facts({ commits: ["Wire it up", "And again"] }))],
    ["a dirty file", smartpickFingerprint(cands("a", "b"), facts({ dirty: ["M src/a.ts", "?? notes.md"] }))],
    ["a branch", smartpickFingerprint(cands("a", "b"), facts({ branch: "wip" }))],
    ["the list order", smartpickFingerprint([cands("a", "b")[1], cands("a", "b")[0]], facts())],
    // `text` is turn ONE, so editing turns 2..n of a chain — or a one-turn item
    // becoming a chain, which stops it being mergeable at all — was invisible
    // here: the repo read "nothing has changed since the last look" about a
    // list whose merge options had changed underneath it.
    ["a chain", smartpickFingerprint([cand("a", { order: 10, steps: 3 }), cand("b", { order: 20 })], facts())],
  ];
  for (const [what, fp] of moved) assert.notEqual(fp, base, `${what} did not change the fingerprint`);
});

// ── The sentences, which are the contract ────────────────────────────────────

const facts0 = { merged: 0, sorted: 0, durationMs: 0 };

test("every outcome has a sentence, and exactly the right ones end on the promise", () => {
  // `s.length > 10` is true of any string, so it pins nothing on its own: what
  // the suite has to hold is WHICH outcomes carry the safety promise and which
  // must not, because both mistakes are silent. A promise missing from a failed
  // pass leaves somebody wondering whether their backlog was rewritten; a
  // promise on `late` tells them the list was untouched by the one event that
  // is about the list having moved on without the answer.
  for (const outcome of SMARTPICK_OUTCOMES) {
    const s = smartpickOutcomeText({ ...facts0, outcome });
    assert.ok(s && s.length > 10, `${outcome} said “${s}”`);
  }
  const promises = (s) => s.endsWith("fired in the order you had");
  for (const outcome of ["failed", "timeout", "limited"]) {
    assert.ok(
      promises(smartpickOutcomeText({ ...facts0, outcome, durationMs: 20_000 })),
      `${outcome} must promise the backlog was untouched`,
    );
  }
  // The churn guard spent time and has a gap to report, so it promises too.
  assert.ok(promises(smartpickOutcomeText({ ...facts0, outcome: "skipped", sinceMs: 9_000 })));
  // These three must NOT: two of them moved the list, and the third bought
  // nothing and makes no claim about it.
  assert.equal(promises(smartpickOutcomeText({ ...facts0, outcome: "skipped" })), false);
  assert.equal(promises(smartpickOutcomeText({ ...facts0, outcome: "late" })), false);
  assert.equal(promises(smartpickOutcomeText({ outcome: "applied", merged: 2, mergedInto: 1, sorted: 1, durationMs: 10 })), false);
  assert.equal(promises(smartpickOutcomeText({ ...facts0, outcome: "noop" })), false);
});

test("the exact strings the strip shows", () => {
  assert.equal(
    smartpickOutcomeText({ outcome: "applied", picked: "fix the flaky test", merged: 2, mergedInto: 1, sorted: 4, durationMs: 2100 }),
    "picked “fix the flaky test” · merged 2 → 1 · sorted 4",
  );
  assert.equal(
    smartpickOutcomeText({ outcome: "applied", merged: 5, mergedInto: 2, sorted: 0, durationMs: 2100 }),
    "merged 5 → 2",
  );
  // Both numbers are stored because "merged 5 → 2" is not derivable from either
  // one — so a record that kept only the first says only the first. `?? 1`
  // printed "merged 3 → 1" about three items that may well have become two
  // rows: the one claim this pair of fields exists to make impossible.
  assert.equal(
    smartpickOutcomeText({ outcome: "applied", merged: 3, sorted: 0, durationMs: 2100 }),
    "merged 3",
  );
  assert.equal(smartpickOutcomeText({ ...facts0, outcome: "applied" }), SMARTPICK_NOOP_TEXT);
  assert.equal(smartpickOutcomeText({ ...facts0, outcome: "noop" }), "nothing moved — the order you had is the order it picked");
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "skipped", sinceMs: 9_000 }),
    "looked 9 s ago — fired in the order you had",
  );
  assert.equal(smartpickOutcomeText({ ...facts0, outcome: "skipped" }), "nothing changed since the last look");
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "failed" }),
    "the model answered nothing readable — fired in the order you had",
  );
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "failed", detail: "the pass could not start" }),
    "the pass could not start — fired in the order you had",
  );
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "timeout", durationMs: 20_000 }),
    "timed out after 20 s — fired in the order you had",
  );
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "timeout", durationMs: 800 }),
    "timed out after 0.8 s — fired in the order you had",
  );
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "limited" }),
    "the account is at its usage limit — fired in the order you had",
  );
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "limited", detail: "resets at 14:00" }),
    "the account is at its usage limit — fired in the order you had · resets at 14:00",
  );
  assert.equal(
    smartpickOutcomeText({ ...facts0, outcome: "late" }),
    "an answer arrived after the item had already started — not applied",
  );
});

test("an item is named by what a person typed, never by its id", () => {
  assert.equal(smartpickName(cand("a1b2", { label: "fix the flaky test" })), "fix the flaky test");
  assert.equal(smartpickName(cand("a1b2", { text: "first line\nsecond line" })), "first line");
  assert.equal(smartpickName(cand("a1b2", { text: "" })), "a1b2");
});

// ── A clock is a decision the person made ────────────────────────────────────
//
// A one-off with an instant on it is an ordinary backlog row (recurrence, not
// trigger kind, decides which list a row lives in), so the pass sees it — and
// meets it with three refusals rather than three verbs. Each of them is here,
// and each of them says so out loud, because a correction nobody can see reads
// as the pass not working.

/** The key the host mints for "the same clock": rule, grace, host-wide hold. */
const clock = (at, graceMin = 120, hold = 0) => JSON.stringify([{ kind: "once", at }, graceMin, hold]);
const TONIGHT = clock(2_000);
const TOMORROW = clock(90_000);
/** A candidate wearing a clock, the way `toCandidate` builds one. */
const timed = (id, key, over = {}) => cand(id, { atKey: key, at: "once · Thu 21:00", ...over });

test("a timed row's slot is its clock's — the sort places around it, exactly like a drag", () => {
  const list = [timed("t", TONIGHT, { order: 10 }), cand("b", { order: 20 }), cand("c", { order: 30 })];
  const plan = applySmartPick(proposal({ order: ["c", "b", "t"], pick: "c" }), list);
  assert.equal(plan.orders.find((o) => o.id === "t"), undefined, "the timed row must not be re-slotted");
  assert.deepEqual(
    plan.orders.slice().sort((x, y) => x.order - y.order),
    [{ id: "c", order: 20 }, { id: "b", order: 30 }],
  );
  // And the sentence is the CLOCK's, not the drag's: a note about a row somebody
  // "placed" sends them looking for a drag they never made.
  assert.ok(plan.notes.some((n) => /on a clock of its own/.test(n)), plan.notes.join(" | "));
  assert.ok(!plan.notes.some((n) => /you had placed/.test(n)), plan.notes.join(" | "));
});

test("a pick naming a timed row is corrected to the first item without a clock, and SAYS so", () => {
  const list = [timed("t", TONIGHT, { order: 10 }), cand("b", { order: 20 })];
  const p = cleanSmartPick(answer({ pick: "t", order: ["t", "b"] }), list);
  assert.equal(p.pick, "b", "“next” is the clock's word, not the model's");
  assert.deepEqual(p.order, ["t", "b"], "…and the order it proposed is untouched — only the pick moved");
  assert.ok(p.notes.some((n) => /runs on its own clock/.test(n) && /the first item without one/.test(n)),
    p.notes.join(" | "));
});

test("a repo where EVERY waiting item has a clock has nothing to pick, and the note is not a guess", () => {
  const list = [timed("t", TONIGHT, { order: 10 }), timed("u", TOMORROW, { order: 20 })];
  const p = cleanSmartPick(answer({ pick: "t", order: ["t", "u"] }), list);
  assert.equal(p.pick, null, "null, never a timed row because there was nothing else");
  assert.ok(p.notes.some((n) => /every item waiting here has a clock of its own/.test(n)), p.notes.join(" | "));
  // …and the plan over it moves nothing at all.
  const plan = applySmartPick(p, list);
  assert.deepEqual(plan.orders, []);
  assert.ok(plan.notes.some((n) => /every waiting item here runs on a clock of its own/.test(n)), plan.notes.join(" | "));
});

test("twins on the IDENTICAL clock merge, and the merged row carries it", () => {
  const list = [timed("a", TONIGHT, { order: 10 }), timed("b", TONIGHT, { order: 20 }), cand("c", { order: 30 })];
  const p = cleanSmartPick(answer({
    pick: "c", order: ["a", "b", "c"],
    merges: [{ ids: ["a", "b"], text: "both, tonight", why: "one job" }],
  }), list);
  assert.equal(p.merges.length, 1, p.notes.join(" | "));
  const plan = applySmartPick(p, list);
  assert.equal(plan.merges[0].atKey, TONIGHT, "the clock rides on the plan, or the host posts an untimed row");
  assert.equal(plan.merges[0].order, 10, "and the group keeps the earliest member's slot, being pinned");
  // The untimed row is the pick and takes the one slot the machine may fill.
  assert.deepEqual(plan.orders, [{ id: "c", order: 20 }]);
});

test("rows on ONE clock are sequenced among themselves — inside the group only", () => {
  // The measured case: several items queued for one reset, in one repo, running
  // in the order they happened to be typed. Their instant is the person's
  // statement; which of them goes first at that instant is not, and is exactly
  // what a pass is for.
  const list = [
    timed("t1", TONIGHT, { order: 10 }),
    cand("b", { order: 20 }),
    timed("t2", TONIGHT, { order: 30 }),
    timed("t3", TONIGHT, { order: 40 }),
  ];
  const plan = applySmartPick(proposal({ order: ["t3", "t1", "b", "t2"], pick: "b" }), list);
  const at = (id) => plan.orders.find((o) => o.id === id)?.order;
  // The three seats the clock group owns are 10, 30 and 40 — nothing else — and
  // the pass's own order fills them.
  assert.deepEqual([at("t3"), at("t1"), at("t2")], [10, 30, 40]);
  // The untimed row is untouched in its own slot: no timed row crossed it.
  assert.equal(at("b"), undefined, "the item with no clock kept its place");
  assert.ok(plan.notes.some((n) => /changed places among themselves/.test(n) && /instant they run at is untouched/.test(n)),
    plan.notes.join(" | "));
});

test("two different clocks never trade seats, however the pass orders them", () => {
  const list = [timed("a", TONIGHT, { order: 10 }), timed("b", TOMORROW, { order: 20 })];
  const plan = applySmartPick(proposal({ order: ["b", "a"], pick: null }), list);
  assert.deepEqual(plan.orders, [], "each is alone on its own clock — there is nothing to sequence");
});

test("a hand-placed row keeps its seat INSIDE a clock group too", () => {
  // A drag is the stronger statement in there as well as out here: the dragged
  // row holds slot 10 and the pass seats the other two around it.
  const list = [
    timed("h", TONIGHT, { order: 10, handOrdered: true }),
    timed("t1", TONIGHT, { order: 20 }),
    timed("t2", TONIGHT, { order: 30 }),
  ];
  const plan = applySmartPick(proposal({ order: ["t2", "t1", "h"], pick: null }), list);
  assert.equal(plan.orders.find((o) => o.id === "h"), undefined, "the row you placed did not move");
  const at = (id) => plan.orders.find((o) => o.id === id)?.order;
  assert.deepEqual([at("t2"), at("t1")], [20, 30]);
});

test("a repo of rows all on ONE clock is not told there was nothing to sort", () => {
  const list = [timed("a", TONIGHT, { order: 10 }), timed("b", TONIGHT, { order: 20 })];
  const plan = applySmartPick(proposal({ order: ["b", "a"], pick: null }), list);
  assert.deepEqual(plan.orders.slice().sort((x, y) => x.order - y.order), [{ id: "b", order: 10 }, { id: "a", order: 20 }]);
  assert.ok(!plan.notes.some((n) => /nothing to sort or pick/.test(n)), plan.notes.join(" | "));
});

test("a merge of a timed row with an untimed one is refused — never merged by guessing", () => {
  const list = [timed("a", TONIGHT, { order: 10 }), cand("b", { order: 20 })];
  const p = cleanSmartPick(answer({
    order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }],
  }), list);
  assert.deepEqual(p.merges, [], "nothing was folded");
  assert.deepEqual(p.order, ["a", "b"], "…and both items are still there, with their own words");
  assert.ok(p.notes.some((n) => /does not run on a clock/.test(n) && /never decides a clock/.test(n)),
    p.notes.join(" | "));
});

test("two DIFFERENT clocks are refused too — which time the merged row would carry is a guess", () => {
  const list = [timed("a", TONIGHT, { order: 10, at: "once · Thu 21:00" }),
    timed("b", TOMORROW, { order: 20, at: "once · Fri 09:00" })];
  const p = cleanSmartPick(answer({
    order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }],
  }), list);
  assert.deepEqual(p.merges, []);
  assert.ok(p.notes.some((n) => /once · Thu 21:00/.test(n) && /once · Fri 09:00/.test(n)), p.notes.join(" | "));
});

test("the same clock rendered the same way but graced differently is NOT the same clock", () => {
  // The key is the rule, the grace AND the host-wide hold. `describeRule` says
  // nothing about the last two, so a check on the sentence would fold two rows
  // that are late by different amounts into one row that can only be one.
  const list = [timed("a", clock(2_000, 120), { order: 10 }), timed("b", clock(2_000, 30), { order: 20 })];
  const p = cleanSmartPick(answer({
    order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }],
  }), list);
  assert.deepEqual(p.merges, [], p.notes.join(" | "));
});

test("a re-timed row moves the fingerprint, or the pass is skipped over a clock that changed", () => {
  const base = smartpickFingerprint([timed("a", TONIGHT, { order: 10 }), cand("b", { order: 20 })], facts());
  for (const [what, list] of [
    ["a new instant", [timed("a", TOMORROW, { order: 10 }), cand("b", { order: 20 })]],
    ["a new grace", [timed("a", clock(2_000, 30), { order: 10 }), cand("b", { order: 20 })]],
    ["the clock dropped", [cand("a", { order: 10 }), cand("b", { order: 20 })]],
  ]) {
    assert.notEqual(smartpickFingerprint(list, facts()), base, `${what} did not change the fingerprint`);
  }
});

// ── …and the HOLD is a decision too, clock or no clock ───────────────────────
//
// `atKey` carries the hold — for a row that HAS a clock. *Drop the clock* takes
// the clock and deliberately keeps the hold (the chip on the row says so), so
// the rows this pass meets most are untimed rows that hold: both keys absent,
// the clock rule sees two identical `""`s, and the merge went through with the
// hold nowhere on the plan. The row that replaced them ran while another repo's
// item was mid-turn.

/** A candidate that waits for the whole desktop to be quiet, and has no clock. */
const held = (id, over = {}) => cand(id, { holdForHost: true, ...over });

test("two rows that both hold merge, and the hold rides on the plan", () => {
  const list = [held("a", { order: 10 }), held("b", { order: 20 }), cand("c", { order: 30 })];
  const p = cleanSmartPick(answer({
    pick: "c", order: ["a", "b", "c"],
    merges: [{ ids: ["a", "b"], text: "both, when it's quiet", why: "one job" }],
  }), list);
  assert.equal(p.merges.length, 1, p.notes.join(" | "));
  const plan = applySmartPick(p, list);
  assert.equal(plan.merges[0].holdForHost, true, "or the host posts a row that holds nothing");
  assert.equal(plan.merges[0].atKey, undefined, "and no clock was invented on the way");
});

test("a merge of a held row with an unheld one is refused, exactly as a clock is", () => {
  const list = [held("a", { order: 10 }), cand("b", { order: 20 })];
  const p = cleanSmartPick(answer({
    order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }],
  }), list);
  assert.deepEqual(p.merges, [], "nothing was folded");
  assert.deepEqual(p.order, ["a", "b"], "…and both items are still there, with their own words");
  assert.ok(p.notes.some((n) => /waits until nothing else on the desktop is running/.test(n) && /never drops a hold/.test(n)),
    p.notes.join(" | "));
});

test("a merge whose members disagree leaves the hold ABSENT on the plan, never repaired", () => {
  // `applySmartPick` recomputes rather than trusting, for a proposal that did
  // not come through the sanitiser. Absent, so the host refuses to write it —
  // the same posture `atKey` takes one line above.
  const list = [held("a", { order: 10 }), cand("b", { order: 20 })];
  const plan = applySmartPick(
    { pick: null, order: ["merge:0"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }], notes: [], why: "" },
    list,
  );
  assert.equal(plan.merges[0]?.holdForHost, undefined);
});

test("a hold that changed moves the fingerprint — the key cannot say it for an untimed row", () => {
  const base = smartpickFingerprint([held("a", { order: 10 }), cand("b", { order: 20 })], facts());
  assert.notEqual(smartpickFingerprint([cand("a", { order: 10 }), cand("b", { order: 20 })], facts()), base,
    "dropping the hold did not change the fingerprint");
});

// ── One budget answer, or none at all ────────────────────────────────────────
//
// `pastBudget` on a candidate is a person's waiver IN FORCE. A merge of a
// waived row with an unwaived one used to go through, and the merged row
// silently waited for the budget the person had already answered — or, the
// other way round, would spend past it on words nobody let past. Refused in
// words, like the hold.

const waived = (id, over = {}) => cand(id, { pastBudget: true, ...over });

test("two rows both let past the budget merge, and the waiver rides on the plan", () => {
  const list = [waived("a", { order: 10 }), waived("b", { order: 20 })];
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }] }), list);
  assert.equal(p.merges.length, 1, p.notes.join(" | "));
  assert.equal(applySmartPick(p, list).merges[0].pastBudget, true);
});

test("a merge of a waived row with an unwaived one is refused, in words", () => {
  const list = [waived("a", { order: 10 }), cand("b", { order: 20 })];
  const p = cleanSmartPick(answer({ order: ["a", "b"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }] }), list);
  assert.deepEqual(p.merges, []);
  assert.deepEqual(p.order, ["a", "b"]);
  assert.ok(p.notes.some((n) => /was let past the budget/.test(n) && /never decides a budget/.test(n)), p.notes.join(" | "));
  // …and a proposal that skipped the sanitiser carries no waiver on the plan.
  const plan = applySmartPick({ pick: null, order: ["merge:0"], merges: [{ ids: ["a", "b"], text: "both", why: "one job" }], notes: [], why: "" }, list);
  assert.equal(plan.merges[0]?.pastBudget, undefined);
});

test("a waiver moves the fingerprint, and a repo with none keeps the one it had", () => {
  const plain = [cand("a", { order: 10 }), cand("b", { order: 20 })];
  const base = smartpickFingerprint(plain, facts());
  assert.notEqual(smartpickFingerprint([waived("a", { order: 10 }), cand("b", { order: 20 })], facts()), base);
  assert.equal(smartpickFingerprint([cand("a", { order: 10, pastBudget: false }), cand("b", { order: 20 })], facts()), base);
});
