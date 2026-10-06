// The rules that stand between a confident-sounding assessment and eighty-four
// prompts nobody can get back (`shared/src/assess.ts`).
//
// The run asks the CLI to read a whole repo and say what is already done, what
// is obsolete, what is covered by something else, and what is still worth
// doing. The expected failure — not the surprising one — is a model saying
// "implemented" about something half-implemented, and the cost of believing it
// is a sentence somebody wrote and can no longer find.
//
// So every assertion below is about a claim being refused, or about a claim
// being kept honest: no citation means no verdict; a supersede graph is
// flattened to the one hop a phone can audit; a merge — the one verdict that
// writes a prompt in place of the user's own — has to be two to six ids, each
// claimed by exactly one outcome; and an item the assessment simply did not
// mention comes back as `unclear` rather than quietly disappearing.
//
// Pure, so all of it runs from literals with no host, nothing spawned, and no
// `packages/host/dist` in existence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MERGE_SIZE,
  MAX_NEW,
  MAX_PROMPT_CHARS,
  MAX_EVIDENCE_CHARS,
  ASSESS_PIN_FREE,
  ASSESS_PIN_KEEP,
  ASSESS_NAME_SKIP,
  ASSESS_NAME_WRITE,
  applyAssessment,
  assessNameCount,
  assessNameNote,
  assessNameQuestion,
  assessPinNote,
  assessPinQuestion,
  assessCounts,
  assessOrigin,
  assessRowSentence,
  cleanAssessment,
} from "../dist/index.js";

const item = (id, over = {}) => ({ id, source: "intent", text: `words for ${id}`, ...over });
const input = (...ids) => ids.map((id) => item(id));
const rowOf = (p, id) => p.rows.find((r) => r.id === id);
const verdicts = (p) => Object.fromEntries(p.rows.map((r) => [r.id, r.verdict]));

// ── The rule the whole module exists for ─────────────────────────────────────

test("a `done` with no evidence is not a verdict — it is downgraded to unclear", () => {
  const p = cleanAssessment({ items: [{ id: "a", verdict: "done" }] }, input("a"));
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "no-evidence");
  // And it says so, rather than a row that silently became unclear.
  assert.match(assessRowSentence(rowOf(p, "a")), /nothing was cited/);
});

test("evidence that is only whitespace is no evidence at all", () => {
  const p = cleanAssessment({ items: [{ id: "a", verdict: "obsolete", evidence: "   \n\t " }] }, input("a"));
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "no-evidence");
});

test("a `superseded` with no evidence is downgraded even when it names a real item", () => {
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "superseded", supersededBy: "b", evidence: "" }, { id: "b", verdict: "wanted" }] },
    input("a", "b"),
  );
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "no-evidence");
});

test("a citation IS enough — an evidenced verdict survives untouched", () => {
  const p = cleanAssessment({ items: [{ id: "a", verdict: "done", evidence: "src/foo.ts:41" }] }, input("a"));
  assert.deepEqual(rowOf(p, "a"), { id: "a", verdict: "done", evidence: "src/foo.ts:41" });
});

// ── Nothing vanishes, nothing is invented ────────────────────────────────────

test("an item the assessment never mentioned comes back as unclear, never missing", () => {
  const p = cleanAssessment({ items: [{ id: "a", verdict: "done", evidence: "src/a.ts:1" }] }, input("a", "b"));
  assert.equal(p.rows.length, 2);
  assert.equal(rowOf(p, "b").verdict, "unclear");
  assert.equal(rowOf(p, "b").downgraded, "unmentioned");
});

test("a verdict for an id that was never in the list is dropped, and said out loud", () => {
  const p = cleanAssessment(
    { items: [{ id: "ghost", verdict: "done", evidence: "src/x.ts:1" }] },
    input("a"),
  );
  assert.deepEqual(p.rows.map((r) => r.id), ["a"]);
  assert.ok(p.notes.some((n) => n.includes("ghost")));
});

test("a context row is read, never verdicted", () => {
  // Finished work goes in so the CLI can tell what is LEFT; retiring it a
  // second time is not a thing anybody asked for.
  const items = [item("a"), item("d", { context: true, state: "done" })];
  const p = cleanAssessment({ items: [{ id: "d", verdict: "done", evidence: "src/d.ts:9" }] }, items);
  assert.deepEqual(p.rows.map((r) => r.id), ["a"]);
  assert.ok(p.notes.some((n) => n.includes("context")));
});

test("two verdicts for one id use neither", () => {
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "done", evidence: "src/a.ts:1" },
        { id: "a", verdict: "wanted" },
      ],
    },
    input("a"),
  );
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "duplicate");
});

test("a verdict word this app does not know becomes unclear, not a guess", () => {
  const p = cleanAssessment({ items: [{ id: "a", verdict: "probably-fine", evidence: "src/a.ts:1" }] }, input("a"));
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "unknown-verdict");
});

test("a citation is a label and is capped; the cap never reaches the user's own words", () => {
  const long = "x".repeat(MAX_EVIDENCE_CHARS + 500);
  const p = cleanAssessment({ items: [{ id: "a", verdict: "done", evidence: long }] }, input("a"));
  assert.equal(rowOf(p, "a").evidence.length, MAX_EVIDENCE_CHARS);
  assert.equal(rowOf(p, "a").verdict, "done");
});

// ── The supersede graph, flattened to one hop ────────────────────────────────

test("superseded pointing at itself is unclear", () => {
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "superseded", supersededBy: "a", evidence: "same thing" }] },
    input("a"),
  );
  assert.equal(rowOf(p, "a").downgraded, "supersede-self");
});

test("superseded pointing at an id that was not in the list is unclear", () => {
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "superseded", supersededBy: "nope", evidence: "covered over there" }] },
    input("a"),
  );
  assert.equal(rowOf(p, "a").downgraded, "supersede-unknown");
});

test("a two-item supersede cycle leaves both undecided", () => {
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "superseded", supersededBy: "b", evidence: "b covers it" },
        { id: "b", verdict: "superseded", supersededBy: "a", evidence: "a covers it" },
      ],
    },
    input("a", "b"),
  );
  assert.deepEqual(verdicts(p), { a: "unclear", b: "unclear" });
  assert.equal(rowOf(p, "a").downgraded, "supersede-cycle");
  assert.equal(rowOf(p, "b").downgraded, "supersede-cycle");
});

test("a chain a→b→c is flattened: both point at c, which is where the work is", () => {
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "superseded", supersededBy: "b", evidence: "b covers it" },
        { id: "b", verdict: "superseded", supersededBy: "c", evidence: "c covers it" },
        { id: "c", verdict: "wanted", rank: 1 },
      ],
    },
    input("a", "b", "c"),
  );
  assert.equal(rowOf(p, "a").supersededBy, "c");
  assert.equal(rowOf(p, "b").supersededBy, "c");
  assert.equal(rowOf(p, "c").verdict, "wanted");
});

// ── Merging: the verdict that writes a prompt ────────────────────────────────

const merge = (over = {}) => ({ gid: "g1", ids: ["a", "b"], prompt: "do the one job", rationale: "same subsystem", ...over });

test("a merge group of exactly two stands", () => {
  const p = cleanAssessment({ merges: [merge()] }, input("a", "b"));
  assert.equal(p.merges.length, 1);
  assert.deepEqual(p.merges[0].ids, ["a", "b"]);
  assert.deepEqual(verdicts(p), { a: "merged", b: "merged" });
  assert.equal(rowOf(p, "a").gid, "g1");
});

test("a merge group of one is not a merge — it is dropped and the item keeps its own words", () => {
  const p = cleanAssessment({ merges: [merge({ ids: ["a"] })] }, input("a", "b"));
  assert.equal(p.merges.length, 0);
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "merge-dropped");
});

test("a merge group over the size cap is dropped and its members fall back to unclear", () => {
  const ids = Array.from({ length: MAX_MERGE_SIZE + 1 }, (_, i) => `i${i}`);
  const p = cleanAssessment({ merges: [merge({ ids })] }, ids.map((id) => item(id)));
  assert.equal(p.merges.length, 0);
  for (const id of ids) assert.equal(rowOf(p, id).verdict, "unclear");
  assert.ok(p.notes.some((n) => n.includes(String(MAX_MERGE_SIZE))));
});

test("a merge group of exactly the size cap still stands", () => {
  const ids = Array.from({ length: MAX_MERGE_SIZE }, (_, i) => `i${i}`);
  const p = cleanAssessment({ merges: [merge({ ids })] }, ids.map((id) => item(id)));
  assert.equal(p.merges.length, 1);
  assert.equal(p.merges[0].ids.length, MAX_MERGE_SIZE);
});

test("a merge group with no prompt is dropped — there is nothing to run in place of the words", () => {
  const p = cleanAssessment({ merges: [merge({ prompt: "  " })] }, input("a", "b"));
  assert.equal(p.merges.length, 0);
  assert.deepEqual(verdicts(p), { a: "unclear", b: "unclear" });
});

test("a merge group whose prompt is over the cap is dropped, never cut short", () => {
  const p = cleanAssessment({ merges: [merge({ prompt: "x".repeat(MAX_PROMPT_CHARS + 1) })] }, input("a", "b"));
  assert.equal(p.merges.length, 0);
  assert.ok(p.notes.some((n) => n.includes("cut short")));
});

test("a merge group naming ids that were not in the list drops those ids and keeps the rest", () => {
  const p = cleanAssessment({ merges: [merge({ ids: ["a", "b", "ghost"] })] }, input("a", "b"));
  assert.equal(p.merges.length, 1);
  assert.deepEqual(p.merges[0].ids, ["a", "b"]);
});

test("...and dies when fewer than two real ids are left", () => {
  const p = cleanAssessment({ merges: [merge({ ids: ["a", "ghost"] })] }, input("a", "b"));
  assert.equal(p.merges.length, 0);
  assert.equal(rowOf(p, "a").verdict, "unclear");
});

test("an id in two groups is undecided everywhere and taken out of both", () => {
  const p = cleanAssessment(
    {
      merges: [
        merge({ gid: "g1", ids: ["a", "b", "c"] }),
        merge({ gid: "g2", ids: ["c", "d", "e"] }),
      ],
    },
    input("a", "b", "c", "d", "e"),
  );
  assert.deepEqual(p.merges.map((g) => g.ids), [["a", "b"], ["d", "e"]]);
  assert.equal(rowOf(p, "c").verdict, "unclear");
  assert.equal(rowOf(p, "c").downgraded, "merge-conflict");
});

test("an id that is both `wanted` and in a group is undecided, and the group loses it", () => {
  const p = cleanAssessment(
    {
      items: [{ id: "c", verdict: "wanted", rank: 2 }],
      merges: [merge({ ids: ["a", "b", "c"] })],
    },
    input("a", "b", "c"),
  );
  assert.deepEqual(p.merges[0].ids, ["a", "b"]);
  assert.equal(rowOf(p, "c").verdict, "unclear");
  assert.equal(rowOf(p, "c").downgraded, "merge-conflict");
});

test("...and if that leaves fewer than two, the whole group goes", () => {
  const p = cleanAssessment(
    {
      items: [{ id: "b", verdict: "wanted" }],
      merges: [merge({ ids: ["a", "b"] })],
    },
    input("a", "b"),
  );
  assert.equal(p.merges.length, 0);
  assert.deepEqual(verdicts(p), { a: "unclear", b: "unclear" });
});

test("a row that says `merged` about the group it is actually in is not a conflict", () => {
  const p = cleanAssessment(
    {
      items: [{ id: "a", verdict: "merged", gid: "g1" }, { id: "b", verdict: "merged", gid: "g1" }],
      merges: [merge()],
    },
    input("a", "b"),
  );
  assert.equal(p.merges.length, 1);
  assert.deepEqual(verdicts(p), { a: "merged", b: "merged" });
});

test("a row that says `merged` with no surviving group behind it is unclear", () => {
  const p = cleanAssessment({ items: [{ id: "a", verdict: "merged", gid: "nope" }] }, input("a"));
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "merge-unknown");
});

// ── New items ────────────────────────────────────────────────────────────────

test("new items past the cap are dropped, not shortened, and the drop is said out loud", () => {
  const news = Array.from({ length: MAX_NEW + 3 }, (_, i) => ({ prompt: `new thing ${i}` }));
  const p = cleanAssessment({ new: news }, input("a"));
  assert.equal(p.news.length, MAX_NEW);
  assert.ok(p.notes.some((n) => n.includes("not shortened")));
});

test("a new item with no prompt is dropped", () => {
  const p = cleanAssessment({ new: [{ prompt: "   " }, { prompt: "real one" }] }, input("a"));
  assert.deepEqual(p.news.map((n) => n.prompt), ["real one"]);
});

// ── Shape tolerance, claim strictness ────────────────────────────────────────

test("a bare array of rows is read the same as {items:[…]}", () => {
  const p = cleanAssessment([{ id: "a", verdict: "done", evidence: "src/a.ts:1" }], input("a"));
  assert.equal(rowOf(p, "a").verdict, "done");
});

test("junk in, every item still comes back with a row", () => {
  for (const junk of [null, undefined, 42, "nope", { items: "no" }, { merges: 7 }]) {
    const p = cleanAssessment(junk, input("a", "b"));
    assert.deepEqual(verdicts(p), { a: "unclear", b: "unclear" });
  }
});

test("a wanted row with no rank still gets a position, and is not downgraded for it", () => {
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "wanted", rank: 3 }, { id: "b", verdict: "wanted" }] },
    input("a", "b"),
  );
  assert.equal(rowOf(p, "a").rank, 3);
  assert.equal(rowOf(p, "b").verdict, "wanted");
  assert.ok(rowOf(p, "b").rank > 3);
});

test("assessCounts counts every row exactly once", () => {
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "done", evidence: "src/a.ts:1" }, { id: "b", verdict: "wanted" }] },
    input("a", "b", "c"),
  );
  const c = assessCounts(p);
  assert.equal(c.done + c.wanted + c.unclear, 3);
  assert.deepEqual([c.done, c.wanted, c.unclear], [1, 1, 1]);
});

// ── Applying: proposal + approvals → mutations ───────────────────────────────

const ctx = (items, runId = "r1") => ({ runId, items });

test("nothing applies itself: no approvals, no mutations", () => {
  // Every kind of mutation is on the table here — a retiring verdict, a rank, a
  // merge and a new item — and an empty set of choices must produce none of
  // them. The run is a proposal; the person is the one who applies it.
  const items = input("a", "b", "c", "d");
  const p = cleanAssessment(
    {
      items: [{ id: "a", verdict: "done", evidence: "src/a.ts:1" }, { id: "b", verdict: "wanted", rank: 1 }],
      merges: [merge({ ids: ["c", "d"] })],
      new: [{ prompt: "a missing piece" }],
    },
    items,
  );
  assert.deepEqual(applyAssessment(p, {}, ctx(items)), { dismiss: [], rank: [], post: [], requeue: [], pinRanks: false, name: [] });
});

test("whether an approved order stays put is the caller's answer, and absent means it does not", () => {
  // **The question `AssessSheet` asks at apply time.** Applying an assessment
  // writes each wanted row's rank as its `order`; the smart pick then re-sorts
  // a repo's waiting items before each fire, leaving alone only rows marked as
  // placed by a person. Until this flag existed an applied rank carried no such
  // mark, so an ordering somebody read sixty-two verdicts to approve was
  // re-decided by a toolless pass that had seen only the item text.
  const items = input("a", "b");
  const p = cleanAssessment({
    items: [{ id: "a", verdict: "wanted", rank: 2 }, { id: "b", verdict: "wanted", rank: 1 }],
  }, items);
  const choices = { rows: ["a", "b"] };

  // The ranks themselves do not change with the answer — only whether they are
  // marked as a person's decision.
  const free = applyAssessment(p, choices, ctx(items));
  const pinned = applyAssessment(p, { ...choices, pinRanks: true }, ctx(items));
  assert.deepEqual(free.rank, pinned.rank);
  assert.deepEqual(free.rank.map((r) => [r.id, r.rank]).sort(), [["a", 2], ["b", 1]]);

  // **Absent is false**, which is the behaviour every apply had before the
  // question existed — an older client applying a proposal changes nothing.
  assert.equal(free.pinRanks, false);
  assert.equal(applyAssessment(p, { ...choices, pinRanks: false }, ctx(items)).pinRanks, false);
  assert.equal(pinned.pinRanks, true);
  // Only a literal `true` pins: a truthy stray off the wire must not silently
  // freeze a repo the smart pick is grooming.
  assert.equal(applyAssessment(p, { ...choices, pinRanks: 1 }, ctx(items)).pinRanks, false);
});

test("the ordering question and its two answers say what they do, and neither is the safe one", () => {
  assert.match(assessPinQuestion(7), /applies an order to 7 items/);
  assert.match(assessPinQuestion(1), /1 item\b/);
  assert.match(assessPinQuestion(3), /stay as you approved it\?$/);
  // Both labels name an action. A pair where one said "keep" and the other said
  // nothing would make the second read as the risky one, and it is not: a repo
  // the smart pick grooms daily wants its order to keep breathing.
  assert.match(ASSESS_PIN_KEEP, /keep this order/);
  assert.match(ASSESS_PIN_FREE, /smart pick may re-sort/);
  assert.notEqual(ASSESS_PIN_KEEP, ASSESS_PIN_FREE);
  // The consequence is not on either label, so it is said underneath — and the
  // pinned half says it is the SAME mark a drag leaves, which is what makes the
  // row's chip and this sentence one claim rather than two.
  assert.match(assessPinNote(true), /placed by you, the way a drag is/);
  assert.match(assessPinNote(true), /never moves them/);
  assert.match(assessPinNote(false), /may re-order these before an item fires/);
  // "may", never "will": the smart pick runs only in repos it is switched on
  // for, so a promise either way would be wrong in most of them.
  assert.doesNotMatch(assessPinNote(false), /will re-order/);
});

test("an accepted retiring verdict dismisses the row with its verdict and citation on it", () => {
  const items = input("a");
  const p = cleanAssessment({ items: [{ id: "a", verdict: "done", evidence: "src/a.ts:41" }] }, items);
  const m = applyAssessment(p, { rows: ["a"] }, ctx(items));
  assert.deepEqual(m.post, []);
  assert.equal(m.dismiss.length, 1);
  assert.deepEqual(m.dismiss[0], {
    id: "a",
    source: "intent",
    verdict: "done",
    reason: "already done — src/a.ts:41",
    evidence: "src/a.ts:41",
  });
});

test("an approved merge posts ONE prompt carrying its source ids, and dismisses every member", () => {
  const items = input("a", "b");
  const p = cleanAssessment({ merges: [merge()] }, items);
  const m = applyAssessment(p, { merges: ["g1"] }, ctx(items));
  assert.equal(m.post.length, 1);
  assert.equal(m.post[0].prompt, "do the one job");
  assert.deepEqual(m.post[0].sourceIds, ["a", "b"]);
  assert.equal(m.post[0].origin, assessOrigin("r1"));
  assert.deepEqual(m.dismiss.map((d) => d.id), ["a", "b"]);
  assert.ok(m.dismiss.every((d) => d.verdict === "merged" && d.gid === "g1"));
});

test("accepting a merged ROW without approving its group does nothing — the words would go nowhere", () => {
  const items = input("a", "b");
  const p = cleanAssessment({ merges: [merge()] }, items);
  const m = applyAssessment(p, { rows: ["a", "b"] }, ctx(items));
  assert.deepEqual(m, { dismiss: [], rank: [], post: [], requeue: [], pinRanks: false, name: [] });
});

test("approving the group is one decision about all N, ticked rows or not", () => {
  const items = input("a", "b");
  const p = cleanAssessment({ merges: [merge()] }, items);
  const m = applyAssessment(p, { merges: ["g1"], rows: ["a"] }, ctx(items));
  assert.deepEqual(m.dismiss.map((d) => d.id), ["a", "b"]);
  assert.equal(m.post.length, 1);
});

test("a wanted row already in the queue is ranked, never posted — a second copy of the words is how a prompt runs twice", () => {
  const items = [item("a", { state: "queued" })];
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 4 }] }, items);
  const m = applyAssessment(p, { rows: ["a"] }, ctx(items));
  assert.deepEqual(m.post, []);
  assert.deepEqual(m.dismiss, []);
  assert.deepEqual(m.rank, [{ id: "a", rank: 4 }]);
});

// ── `still wanted` on a row that is no longer waiting ────────────────────────
//
// The verdict means the same thing whatever state the row is in, but carrying
// it out does not. A `queued` row gets a position. A `failed` row is terminal —
// the tick's ladder never looks at it again — so a position on it is a place in
// a queue it is not in, and the sheet saying "position 1 in the order" about it
// is a promise nothing keeps. Measured on the desktop this was written on: the
// repo's own backlog was 0 queued and 19 failed, i.e. every verdict the run
// could usefully reach was one whose approval did nothing at all.

test("a wanted verdict on a FAILED row puts it back in the queue", () => {
  const items = [item("a", { state: "failed" })];
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 1 }] }, items);
  const m = applyAssessment(p, { rows: ["a"] }, ctx(items));
  assert.deepEqual(m.requeue, ["a"]);
  // The id, and nothing else: the words, the place and the failure stay on the
  // row the host already has. Nothing is posted — a second row carrying the
  // same prompt is the duplicate this whole module exists to avoid.
  assert.deepEqual(m.post, []);
  assert.deepEqual(m.dismiss, []);
});

test("a re-queued row still takes the place the assessment gave it — the two are not alternatives", () => {
  const items = [item("a", { state: "failed" })];
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 3 }] }, items);
  const m = applyAssessment(p, { rows: ["a"] }, ctx(items));
  assert.deepEqual(m.requeue, ["a"]);
  assert.deepEqual(m.rank, [{ id: "a", rank: 3 }]);
});

test("a failed row is put back even when the verdict named no position", () => {
  // `cleanAssessment` hands every unranked `wanted` row the next free slot, so
  // this is asserted through `applyAssessment` on a proposal that never went
  // through it — the rank was never the whole of the verdict, and a row with no
  // place to be moved to is still a row somebody said was worth doing.
  const items = [item("a", { state: "failed" })];
  const m = applyAssessment(
    { rows: [{ id: "a", verdict: "wanted", evidence: "" }], merges: [], news: [], notes: [] },
    { rows: ["a"] },
    ctx(items),
  );
  assert.deepEqual(m.requeue, ["a"]);
  assert.deepEqual(m.rank, []);
});

test("a row that is still waiting is ranked and never put back — it is already in the order", () => {
  for (const state of ["queued", "blocked", undefined]) {
    const items = [item("a", { state })];
    const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 2 }] }, items);
    const m = applyAssessment(p, { rows: ["a"] }, ctx(items));
    assert.deepEqual(m.requeue, [], `${state ?? "no state"} is not a row to put back`);
    assert.deepEqual(m.rank, [{ id: "a", rank: 2 }], `${state ?? "no state"} is ranked`);
  }
});

test("the failure the run judged travels on the item, and applying is not the thing that checks it", () => {
  // `state: "failed"` is a STATE, not an event, and this document is written
  // when the run starts and applied whenever the person taps. In between, the
  // row can be revived by Activity or a hand tap, run, and fail DIFFERENTLY —
  // and it is still `failed`, so a state-only guard re-runs work on the
  // strength of a failure nobody read. `AssessItem.failedAt` is which failure
  // this run was looking at; the HOST compares it with the live
  // `Intent.settledAt` and drops the id on a mismatch.
  //
  // Which is why this test asserts the mutation is UNCHANGED: the decision is
  // the same decision, so `applyAssessment` reads nothing here and still says
  // "put this back". Moving the comparison in would put a refusal inside a pure
  // function that cannot see the store, and CLAUDE.md's rule is that nothing
  // applies itself.
  const items = [item("a", { state: "failed", failedAt: 1_700_000_000_000 })];
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 1 }] }, items);
  assert.deepEqual(applyAssessment(p, { rows: ["a"] }, ctx(items)).requeue, ["a"]);
  // And an item that cannot say — every document written before the field — is
  // applied on the state alone, exactly as it was: absence is an older writer,
  // never a reason to refuse somebody's approved verdict.
  const old = [item("a", { state: "failed" })];
  assert.deepEqual(applyAssessment(p, { rows: ["a"] }, ctx(old)).requeue, ["a"]);
});

test("a wanted PAD NOTE is never put back — it was never in a queue to leave", () => {
  const items = [item("n1", { source: "note", state: "failed" })];
  const p = cleanAssessment({ items: [{ id: "n1", verdict: "wanted", rank: 1 }] }, items);
  assert.deepEqual(applyAssessment(p, { rows: ["n1"] }, ctx(items)).requeue, []);
});

test("a failed CONTEXT row is not put back — it was given to be read, not decided about", () => {
  const items = [item("a", { state: "failed", context: true }), item("b", { state: "failed" })];
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 1 }] }, items);
  const m = applyAssessment(p, { rows: ["a", "b"] }, ctx(items));
  assert.deepEqual(m.requeue, []);
  // And it says why, rather than a verdict that quietly went missing.
  assert.ok(p.notes.some((n) => /context only/.test(n)));
});

test("an UNTICKED failed row stays failed, however confidently the run said `wanted`", () => {
  // Nothing applies itself. The one thing standing between a proposal and
  // nineteen revived rows is the tap, and this is that rule at the only place
  // it is enforced.
  const items = [item("a", { state: "failed" })];
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 1 }] }, items);
  assert.deepEqual(applyAssessment(p, {}, ctx(items)).requeue, []);
  assert.deepEqual(applyAssessment(p, { rows: ["other"] }, ctx(items)).requeue, []);
});

test("no verdict but `wanted` ever puts a row back — the others retire it or decide nothing", () => {
  // A retiring verdict on a failed row is a row being filed away, and `unclear`
  // reached no decision at all. Reviving either would be this module inventing
  // a conclusion nobody drew.
  for (const [verdict, extra] of [
    ["done", { evidence: "src/a.ts:41" }],
    ["obsolete", { evidence: "that file is gone" }],
    ["superseded", { evidence: "b covers it", supersededBy: "b" }],
    ["unclear", { evidence: "could not tell" }],
  ]) {
    const items = [item("a", { state: "failed" }), item("b", { state: "queued" })];
    const p = cleanAssessment({ items: [{ id: "a", verdict, ...extra }] }, items);
    const m = applyAssessment(p, { rows: ["a"] }, ctx(items));
    assert.deepEqual(m.requeue, [], `${verdict} does not put a row back`);
  }
  // `merged` included, via the group that is the actual decision: the words are
  // being replaced by the posted prompt, so the failed row is dismissed and the
  // thing that runs is the new one.
  const merged = input("a", "b").map((it) => ({ ...it, state: "failed" }));
  const pm = cleanAssessment({ merges: [merge()] }, merged);
  const mm = applyAssessment(pm, { merges: ["g1"], rows: ["a", "b"] }, ctx(merged));
  assert.deepEqual(mm.requeue, []);
  assert.equal(mm.post.length, 1);
});

test("a wanted PAD NOTE is not ranked into an order it does not have", () => {
  const items = [item("n1", { source: "note" })];
  const p = cleanAssessment({ items: [{ id: "n1", verdict: "wanted", rank: 2 }] }, items);
  assert.deepEqual(applyAssessment(p, { rows: ["n1"] }, ctx(items)), { dismiss: [], rank: [], post: [], requeue: [], pinRanks: false, name: [] });
});

test("a dismissed pad note says which store its words are in", () => {
  const items = [item("n1", { source: "note" })];
  const p = cleanAssessment({ items: [{ id: "n1", verdict: "obsolete", evidence: "that file is gone" }] }, items);
  const m = applyAssessment(p, { rows: ["n1"] }, ctx(items));
  assert.equal(m.dismiss[0].source, "note");
});

test("an accepted `unclear` does nothing — a tap cannot supply a decision nobody reached", () => {
  const items = input("a");
  const p = cleanAssessment({ items: [{ id: "a", verdict: "done" }] }, items);
  assert.deepEqual(applyAssessment(p, { rows: ["a"] }, ctx(items)), { dismiss: [], rank: [], post: [], requeue: [], pinRanks: false, name: [] });
});

test("approved new items are posted with an origin pointing back at the run", () => {
  const items = input("a");
  const p = cleanAssessment({ new: [{ prompt: "first" }, { prompt: "second", rank: 9 }] }, items);
  const m = applyAssessment(p, { news: [1] }, ctx(items, "run7"));
  assert.deepEqual(m.post, [{ prompt: "second", rank: 9, origin: "assess:run7" }]);
});

test("approvals naming ids, groups or indices that do not exist are ignored", () => {
  const items = input("a");
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted" }] }, items);
  const m = applyAssessment(p, { rows: ["ghost"], merges: ["nope"], news: [7] }, ctx(items));
  assert.deepEqual(m, { dismiss: [], rank: [], post: [], requeue: [], pinRanks: false, name: [] });
});


// ── What the run may conclude about a NAME ──────────────────────────────────
//
// Naming is a reading of the WORDS, not a claim about the codebase — which is
// why every rule below points the opposite way from the rest of this file. A
// verdict with no citation is refused; a title on that same row is kept, because
// a run that could not tell whether the thing was done can still tell that it is
// about a crash in the uploader.

test("a title and a kind ride on a row the run could decide about", () => {
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "wanted", headline: "Uploader drops big files", category: "bug" }] },
    input("a"),
  );
  assert.equal(rowOf(p, "a").headline, "Uploader drops big files");
  assert.equal(rowOf(p, "a").category, "bug");
});

test("…and on one it could NOT — a downgrade is about the claim, never about the words", () => {
  // `done` with nothing behind it loses its verdict. It does not lose its
  // reading of the sentence, which is the only thing the sheet can still show.
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "done", headline: "Uploader drops big files", category: "bug" }] },
    input("a"),
  );
  assert.equal(rowOf(p, "a").verdict, "unclear");
  assert.equal(rowOf(p, "a").downgraded, "no-evidence");
  assert.equal(rowOf(p, "a").headline, "Uploader drops big files");
  assert.equal(rowOf(p, "a").category, "bug");
});

test("a row the CLI itself called unclear is named like any other", () => {
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "unclear", evidence: "could not find it", headline: "Retry policy on uploads", category: "chore" }] },
    input("a"),
  );
  assert.deepEqual(rowOf(p, "a"), {
    id: "a", verdict: "unclear", evidence: "could not find it",
    headline: "Retry policy on uploads", category: "chore",
  });
});

test("a context row is read, never named — a title is a decision about it", () => {
  const items = [item("a"), item("ctx", { context: true })];
  const p = cleanAssessment(
    { items: [{ id: "ctx", verdict: "wanted", headline: "Something about the uploader", category: "bug" }] },
    items,
  );
  assert.equal(rowOf(p, "ctx"), undefined);
});

test("an id named twice keeps neither name, the way it keeps neither verdict", () => {
  // The duplicate rule is about not picking one of two answers at random, and a
  // title is an answer.
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "wanted", headline: "Uploader drops big files", category: "bug" },
        { id: "a", verdict: "done", evidence: "src/a.ts:1", headline: "Retry policy", category: "chore" },
      ],
    },
    input("a"),
  );
  assert.equal(rowOf(p, "a").downgraded, "duplicate");
  assert.equal(rowOf(p, "a").headline, undefined);
  assert.equal(rowOf(p, "a").category, undefined);
});

test("a merge and a new item carry their own name — the prompt under it is the run's own words", () => {
  const p = cleanAssessment(
    {
      merges: [merge({ headline: "One uploader fix", category: "bug" })],
      new: [{ prompt: "add a retry to the uploader", headline: "Uploader retries", category: "enhancement" }],
    },
    input("a", "b"),
  );
  assert.equal(p.merges[0].headline, "One uploader fix");
  assert.equal(p.merges[0].category, "bug");
  assert.equal(p.news[0].headline, "Uploader retries");
  assert.equal(p.news[0].category, "enhancement");
});

test("a title that is only the first words of its item is left off, and counted ONCE", () => {
  // One note per bad row would be a scroll in place of a sheet: a run names
  // every row in the repo, and the fact worth showing is how many were thrown
  // away, not which.
  const items = [
    item("a", { text: "fix the uploader so it stops dropping big files" }),
    item("b", { text: "rewrite the settings sheet from scratch" }),
  ];
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "wanted", headline: "fix the uploader so it stops" },
        { id: "b", verdict: "wanted", headline: "rewrite the settings sheet" },
      ],
    },
    items,
  );
  assert.equal(rowOf(p, "a").headline, undefined);
  assert.equal(rowOf(p, "b").headline, undefined);
  const hits = p.notes.filter((n) => /headline\(s\) were only the first words/.test(n));
  assert.deepEqual(hits, ["2 headline(s) were only the first words of their item and were left off"]);
});

test("a kind outside the four is left off, and counted ONCE — never rounded to chore", () => {
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "wanted", category: "bugfix" },
        { id: "b", verdict: "wanted", category: "improvement" },
      ],
    },
    input("a", "b"),
  );
  assert.equal(rowOf(p, "a").category, undefined);
  assert.equal(rowOf(p, "b").category, undefined);
  const hits = p.notes.filter((n) => /kind\(s\) were not one of/.test(n));
  assert.deepEqual(hits, ["2 kind(s) were not one of bug/feature/enhancement/chore and were left off"]);
});

test("assessNameCount counts rows, groups and new items once each", () => {
  // The number the question is asked about. A row with both halves is still one
  // row a person is deciding about, and a sheet saying "titles 4 items" must
  // not then title five.
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "wanted", headline: "Uploader drops big files", category: "bug" },
        { id: "b", verdict: "wanted", category: "chore" },
        { id: "e", verdict: "wanted" },
      ],
      merges: [merge({ ids: ["c", "d"], headline: "One uploader fix" })],
      new: [{ prompt: "add a retry", category: "enhancement" }, { prompt: "unnamed" }],
    },
    input("a", "b", "c", "d", "e"),
  );
  assert.equal(assessNameCount(p), 4);
  assert.equal(assessNameCount({ rows: [], merges: [], news: [], notes: [] }), 0);
});

test("whether the run's titles go on the rows is the caller's answer, and absent means they do not", () => {
  // `pinRanks`' rule: an older client applying a proposal changes nothing it did
  // not change before.
  const items = input("a");
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "wanted", headline: "Uploader drops big files", category: "bug" }] },
    items,
  );
  assert.deepEqual(applyAssessment(p, { rows: ["a"] }, ctx(items)).name, []);
  assert.deepEqual(applyAssessment(p, { rows: ["a"], writeNames: false }, ctx(items)).name, []);
  assert.deepEqual(applyAssessment(p, { rows: ["a"], writeNames: true }, ctx(items)).name, [
    { id: "a", headline: "Uploader drops big files", category: "bug" },
  ]);
});

test("a name is written whether or not the verdict on that row was accepted", () => {
  // They are different facts: "I do not agree this is done" is not "I do not
  // agree this is about the uploader". Tying them would make the only way to
  // title a row accepting a verdict about it.
  const items = input("a");
  const p = cleanAssessment(
    { items: [{ id: "a", verdict: "done", evidence: "src/a.ts:1", headline: "Uploader drops big files" }] },
    items,
  );
  const m = applyAssessment(p, { writeNames: true }, ctx(items));
  assert.deepEqual(m.dismiss, []);
  assert.deepEqual(m.name, [{ id: "a", headline: "Uploader drops big files" }]);
});

test("a PAD NOTE is never titled — the pad is somebody's typing and this app does not write into it", () => {
  const items = [item("a"), item("n1", { source: "note" })];
  const p = cleanAssessment(
    {
      items: [
        { id: "a", verdict: "wanted", headline: "Uploader drops big files" },
        { id: "n1", verdict: "wanted", headline: "A thought about the uploader" },
      ],
    },
    items,
  );
  const m = applyAssessment(p, { rows: ["a", "n1"], writeNames: true }, ctx(items));
  assert.deepEqual(m.name, [{ id: "a", headline: "Uploader drops big files" }]);
});

test("a posted row carries its name whatever the answer was — it is machine text already", () => {
  // The one asymmetry: `writeNames` asks whether a machine may title words a
  // PERSON wrote. A merged or new row has no such words, so the question does
  // not arise, and a nameless machine-written row is the worse outcome.
  const items = input("a", "b");
  const p = cleanAssessment(
    {
      merges: [merge({ headline: "One uploader fix", category: "bug" })],
      new: [{ prompt: "add a retry", headline: "Uploader retries", category: "enhancement" }],
    },
    items,
  );
  const m = applyAssessment(p, { merges: ["g1"], news: [0] }, ctx(items, "run7"));
  assert.deepEqual(m.name, []);
  assert.equal(m.post[0].headline, "One uploader fix");
  assert.equal(m.post[0].category, "bug");
  assert.equal(m.post[1].headline, "Uploader retries");
  assert.equal(m.post[1].category, "enhancement");
});

test("the naming question and its two answers say what they do, and neither is the safe one", () => {
  // Pinned for `assessPinQuestion`'s reason: the sheet asks it and the host says
  // it back on the row, and a second wording of one decision is how two screens
  // come to disagree about what was decided.
  assert.equal(assessNameQuestion(1), "This run wrote a title or a kind for 1 item. Should they go on the rows?");
  assert.match(assessNameQuestion(14), /14 items/);
  assert.equal(ASSESS_NAME_WRITE, "write them");
  assert.equal(ASSESS_NAME_SKIP, "leave the rows as they are");
  // The write side has to say the protection out loud: it is the only thing
  // between a naming run and words somebody typed, and this is the only place a
  // person reads it.
  assert.equal(
    assessNameNote(true),
    "Written as the run's — a title or kind you typed yourself is never replaced, and you can edit or clear any of them on the row.",
  );
  // …and the skip side must not read as "they are gone".
  assert.equal(assessNameNote(false), "Nothing is titled. The suggestions stay on this sheet only.");
});

// ── A pad note the run says is still worth doing ─────────────────────────────
//
// `wanted` on a note used to be the one verdict with nowhere to go: the note was
// read, judged, counted and left, because the pad is synced client state the
// host does not own. The offer closes that, and the whole of its safety is WHERE
// the words come from — this module copies the input item's own `text`, so
// "it carries the note's words" is true by construction rather than because the
// CLI was asked to copy them and did.

const note = (id, text) => ({ id, source: "note", text });

test("a wanted pad note is offered as a new item carrying its own words, verbatim", () => {
  const words = "  a thought written on a train, with its own\n\nragged spacing  ";
  const items = [note("n1", words)];
  const p = cleanAssessment(
    { items: [{ id: "n1", verdict: "wanted", rank: 3, headline: "the train thought", category: "feature" }] },
    items,
  );
  assert.equal(p.news.length, 1);
  assert.equal(p.news[0].prompt, words, "the note's OWN text, not a trimmed or re-worded copy of it");
  assert.equal(p.news[0].fromNote, "n1", "…saying which note it is, so the phone can clear that note on the receipt");
  assert.equal(p.news[0].rank, 3, "…at the place the run gave the row");
  // The naming rides along: a title is a reading of the words, and these are
  // the same words the run read.
  assert.equal(p.news[0].headline, "the train thought");
  assert.equal(p.news[0].category, "feature");
  // And the row itself is untouched — the offer is an addition, not a verdict
  // rewrite.
  assert.equal(rowOf(p, "n1").verdict, "wanted");
});

test("only `wanted` offers anything — every other verdict on a note offers nothing", () => {
  for (const [verdict, extra] of [
    ["done", { evidence: "src/a.ts:41" }],
    ["obsolete", { evidence: "that file is gone" }],
    ["unclear", { evidence: "could not tell" }],
  ]) {
    const items = [note("n1", "a thought written on a train")];
    const p = cleanAssessment({ items: [{ id: "n1", verdict, ...extra }] }, items);
    assert.deepEqual(p.news, [], `${verdict} on a note offers nothing`);
  }
  // A downgrade is not a `wanted` either: a `done` with no citation lands on
  // `unclear`, which reached no decision, and an offer would be this module
  // inventing one.
  const items = [note("n1", "a thought written on a train")];
  const p = cleanAssessment({ items: [{ id: "n1", verdict: "done" }] }, items);
  assert.equal(rowOf(p, "n1").verdict, "unclear");
  assert.deepEqual(p.news, []);
});

test("a note given as CONTEXT is offered nothing — it was given to be read", () => {
  const items = [{ id: "n1", source: "note", text: "a thought", context: true }, item("a")];
  const p = cleanAssessment({ items: [{ id: "n1", verdict: "wanted", rank: 1 }] }, items);
  assert.deepEqual(p.news, []);
  assert.ok(p.notes.some((n) => /context only/.test(n)));
});

test("an intent row that is still wanted is never offered — its words already have a row", () => {
  // The other half of the same rule, and the one that would run a prompt twice.
  const items = input("a");
  const p = cleanAssessment({ items: [{ id: "a", verdict: "wanted", rank: 1 }] }, items);
  assert.deepEqual(p.news, []);
});

test("the offers are exempt from MAX_NEW — the cap guards a run that INVENTS", () => {
  const notes = Array.from({ length: 4 }, (_, i) => note(`n${i}`, `a thought numbered ${i}`));
  const news = Array.from({ length: MAX_NEW + 2 }, (_, i) => ({ prompt: `new thing ${i}` }));
  const p = cleanAssessment(
    { items: notes.map((n) => ({ id: n.id, verdict: "wanted" })), new: news },
    notes,
  );
  assert.equal(p.news.filter((n) => !n.fromNote).length, MAX_NEW, "the CLI's own list is still capped");
  assert.equal(p.news.filter((n) => n.fromNote).length, 4, "…and every note the person wrote is still offered");
  // Appended, never prepended: `AssessChoices.news` names INDICES, and a client
  // that built them off the CLI's list must keep meaning what it meant.
  assert.deepEqual(p.news.slice(0, MAX_NEW).map((n) => n.fromNote), Array(MAX_NEW).fill(undefined));
});

test("a proposed new item repeating a note word for word is dropped, and the note is offered instead", () => {
  const words = "a thought written on a train";
  const items = [note("n1", words)];
  const p = cleanAssessment(
    { items: [{ id: "n1", verdict: "wanted" }], new: [{ prompt: words }, { prompt: "something else" }] },
    items,
  );
  assert.deepEqual(p.news.map((n) => n.prompt), ["something else", words]);
  assert.equal(p.news[1].fromNote, "n1", "the surviving copy is the note's — the one that can clear the note");
  assert.ok(p.notes.some((n) => /repeated pad note “n1” word for word/.test(n)),
    `the drop is said out loud, naming the note: ${JSON.stringify(p.notes)}`);
});

test("a ticked offer posts the note's words with `fromNote`, and dismisses nothing about the note", () => {
  const words = "a thought written on a train";
  const items = [note("n1", words)];
  const p = cleanAssessment({ items: [{ id: "n1", verdict: "wanted", rank: 2 }] }, items);
  const m = applyAssessment(p, { news: [0] }, ctx(items, "run7"));
  assert.deepEqual(m.post, [{ prompt: words, rank: 2, origin: "assess:run7", fromNote: "n1" }]);
  // Nothing else moves. The note is not retired, not ranked, not named — the
  // host does not own the document it lives in, and the clearing is the phone's
  // on the receipt for that post.
  assert.deepEqual(m.dismiss, []);
  assert.deepEqual(m.rank, []);
  assert.deepEqual(m.requeue, []);
  assert.deepEqual(m.name, []);
});

test("an un-ticked offer posts nothing, however confidently the run said `wanted`", () => {
  // Nothing applies itself: the offer is a row on a sheet, and the tap is the
  // whole of what turns it into work.
  const items = [note("n1", "a thought written on a train")];
  const p = cleanAssessment({ items: [{ id: "n1", verdict: "wanted", rank: 1 }] }, items);
  assert.deepEqual(applyAssessment(p, {}, ctx(items)).post, []);
  assert.deepEqual(applyAssessment(p, { rows: ["n1"] }, ctx(items)).post, [],
    "…and ticking the ROW is not ticking the offer: the words are in `news`, where every post is approved");
});
