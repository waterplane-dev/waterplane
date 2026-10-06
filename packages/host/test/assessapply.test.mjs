/**
 * **What applying a proposal actually does to the store — and in what order.**
 *
 * `applyAssessment` decides; this performs. The two halves are asserted apart
 * because the failure mode that shipped was in neither of them on its own: the
 * pure layer said *still wanted*, the host wrote a sort position, and for a
 * `failed` row that is a position in an order the row is not in. The sheet said
 * "position 1 in the order" over a row the ladder would never look at again.
 *
 * Six rules, each of which is invisible in review:
 *
 *  1. **A ticked `wanted` row that FAILED is put back, and THEN ranked.** Both,
 *     in that order — a rank is only a rank once the row is in the order it
 *     names.
 *  2. **A ticked `wanted` row that is QUEUED is only ranked.** Nothing is put
 *     back that was never out, and `requeueFailed` would refuse it anyway.
 *  3. **A row that is no longer failed at apply time is refused, not counted,
 *     and does not fail the apply.** `AssessMutations.requeue` comes off the
 *     run's START snapshot — twenty minutes old — so "it already ran" is an
 *     expected answer, not an error.
 *  4. **The counts and the sentence.** `requeued` travels through the outcome
 *     into `AssessRun.applied`, and the line a person reads says it in the
 *     words the verb uses.
 *  5. **ONE kick, after the ranks.** Every re-queue passes `kick: false`. A
 *     kick runs a pass synchronously as far as its first `await`, so the
 *     nineteen-row apply this feature was written for fired its FIRST revived
 *     row before the other eighteen revives and the whole rank loop had
 *     happened — with neither the approved order on the rows nor a candidate
 *     list the smart pick would look at (`hold()` refuses a list of one).
 *  6. **"Still failed" is not the same failure.** `state` is a state, not an
 *     event: a row can fail, be put back by hand, run, and fail again in the
 *     twenty minutes a proposal sits on a sheet. `AssessItem.failedAt` is which
 *     failure the run saw, and a row that has settled again since is skipped —
 *     uncounted, and not a failure of the apply.
 *
 * …and the sections below them, added as the apply grew: the naming pass, the
 * pad notes it can file, and — section 9 — the RECEIPT saying which of those
 * rows really landed. That last one is the only delete in this app taken on a
 * REMOTE answer rather than on a durable local copy, so it is the only one that
 * can lose words, and `ok` was never enough to carry it.
 *
 *     node --test packages/host/test/assessapply.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposal, buildAssessInput } from "../dist/assess.js";

const CWD = "/repo/myapp";
const NOW = 1_700_000_000_000;

/** One assessed item, as the run's START snapshot recorded it. */
const item = (id, state, extra = {}) => ({ id, source: "intent", text: `do ${id}`, state, ...extra });

/** One verdict. Only `wanted` matters here; the retirements have their own tests. */
const wanted = (id, rank) => ({ id, verdict: "wanted", evidence: "still the next thing", rank });

/**
 * Enough of `AssessIntents` to watch the order of the calls.
 *
 * `calls` is the whole point: this file is about WHICH verb reaches WHICH row
 * and in what sequence, so every method records itself rather than answering
 * silently. `requeueFailed` re-asks the LIVE state exactly as the manager does
 * — that re-ask is the safety the whole late-apply path rests on, and a fake
 * that always said yes would assert nothing about it.
 */
function fakeIntents(rows, opts = {}) {
  const by = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls = [];
  return {
    calls,
    rows: by,
    get: (id) => by.get(id),
    /**
     * `opts.refusePost` is the store saying NO, which it really does — the
     * manager refuses past `PENDING_MAX` and refuses a draft that could never
     * run. A fake that always said yes made the apply's `if (!r.ok) continue`
     * unreachable, which is the line that tombstoned pad notes for rows that
     * were never written.
     */
    post: (draft) => {
      if (opts.refusePost?.(draft)) {
        calls.push(`post-refused:${draft.id}`);
        return { ok: false, reason: "too many are already waiting" };
      }
      calls.push(`post:${draft.id}`); by.set(draft.id, { ...draft, state: "queued" }); return { ok: true, intent: { id: draft.id } };
    },
    cancel: (id) => { calls.push(`cancel:${id}`); return true; },
    dismiss: (id) => { calls.push(`dismiss:${id}`); return true; },
    edit: (id, patch) => {
      calls.push(`edit:${id}:${patch.order}`);
      const row = by.get(id);
      if (row && typeof patch.order === "number") row.order = patch.order;
      return { ok: !!row };
    },
    requeueFailed: (id, by2, opts) => {
      const row = by.get(id);
      if (!row) return { ok: false, reason: "that intent is gone" };
      if (row.state !== "failed") {
        calls.push(`requeue-refused:${id}`);
        return { ok: false, reason: "it already ran — a done item is re-fired, not put back in the queue" };
      }
      calls.push(`requeue:${id}:${by2.kind}:${by2.runId}`);
      row.state = "queued";
      // Exactly what the manager does, because that is the behaviour under
      // test: a re-queue that was not told otherwise asks the ladder to look,
      // there and then. A fake that swallowed the kick would let the N-kicks
      // bug straight back in with every test still green.
      if (opts?.kick !== false) calls.push("kick");
      return { ok: true };
    },
    /**
     * `IntentManager.name`'s rule, reproduced here because it is the behaviour
     * under test: each half is written only where the row's own author is not
     * `hand`, and what comes BACK is what was actually written. A fake that
     * always said `{headline: true}` would make the count assertions below pass
     * over a store where a person's title had just been overwritten.
     */
    name: (id, n, author) => {
      const row = by.get(id);
      const out = { headline: false, category: false };
      if (!row) return out;
      if (n.headline !== undefined && row.headlineBy !== "hand") {
        row.headline = n.headline; row.headlineBy = author; out.headline = true;
      }
      if (n.category !== undefined && row.categoryBy !== "hand") {
        row.category = n.category; row.categoryBy = author; out.category = true;
      }
      calls.push(`name:${id}:${out.headline ? n.headline : "-"}:${out.category ? n.category : "-"}`);
      return out;
    },
    kick: () => { calls.push("kick"); },
  };
}

/** Enough of `AssessStore` for one apply, and it records what it was told. */
function fakeStore(run) {
  return {
    applied: null,
    get: () => run,
    recordApplied(runId, counts) { this.applied = { runId, counts }; },
  };
}

const runOver = (items, rows) => ({
  runId: "run_7", repoDir: CWD, status: "done",
  input: { items },
  proposal: { rows, merges: [], news: [], notes: [] },
});

test("a ticked failed row is put back and THEN ranked; a queued one is only ranked", () => {
  const run = runOver(
    [item("f1", "failed"), item("q1", "queued")],
    [wanted("f1", 1), wanted("q1", 2)],
  );
  const intents = fakeIntents([{ id: "f1", state: "failed" }, { id: "q1", state: "queued" }]);
  const store = fakeStore(run);

  const out = applyProposal(intents, store, "run_7", { rows: ["f1", "q1"] }, NOW);

  assert.equal(out.ok, true);
  assert.deepEqual(intents.calls, ["requeue:f1:assess:run_7", "edit:f1:1", "edit:q1:2", "kick"],
    "put back first — a rank is only a rank once the row is in the order it names — and the ladder is told LAST");
  assert.equal(intents.rows.get("f1").state, "queued");
  assert.equal(intents.rows.get("f1").order, 1, "…and it takes the place the assessment gave it");
  assert.equal(out.counts.requeued, 1, "the queued row was never out, so it is not counted back in");
  assert.equal(out.counts.ranked, 2, "both were ranked");
});

test("a row that is no longer failed is refused, not counted, and does not fail the apply", () => {
  // The run judged it `failed`; by the time somebody taps Apply it has run. The
  // snapshot cannot know that and the live store can.
  const run = runOver(
    [item("f1", "failed"), item("f2", "failed")],
    [wanted("f1", 1), wanted("f2", 2)],
  );
  const intents = fakeIntents([{ id: "f1", state: "done" }, { id: "f2", state: "failed" }]);
  const store = fakeStore(run);

  const out = applyProposal(intents, store, "run_7", { rows: ["f1", "f2"] }, NOW);

  assert.equal(out.ok, true, "one refusal must not take the rest of the apply with it");
  assert.deepEqual(intents.calls, ["requeue-refused:f1", "requeue:f2:assess:run_7", "edit:f1:1", "edit:f2:2", "kick"]);
  assert.equal(out.counts.requeued, 1, "nothing was put back, so nothing is counted");
  assert.equal(intents.rows.get("f1").state, "done", "and the row that ran is left exactly as it is");
});

test("the count travels into the run, and the sentence says it in the verb's own words", () => {
  const run = runOver(
    [item("f1", "failed"), item("f2", "failed"), item("q1", "queued")],
    [wanted("f1", 1), wanted("f2", 2), wanted("q1", 3)],
  );
  const intents = fakeIntents([{ id: "f1", state: "failed" }, { id: "f2", state: "failed" }, { id: "q1", state: "queued" }]);
  const store = fakeStore(run);

  const out = applyProposal(intents, store, "run_7", { rows: ["f1", "f2", "q1"] }, NOW);

  assert.deepEqual(out.counts, { dismissed: 0, ranked: 3, posted: 0, requeued: 2, named: 0 });
  assert.deepEqual(store.applied, { runId: "run_7", counts: { dismissed: 0, ranked: 3, posted: 0, requeued: 2, named: 0 } });
  assert.equal(out.detail, "0 retired · 3 ranked · 0 posted · 2 put back in the queue");
});

test("an apply that put nothing back says nothing about it", () => {
  const run = runOver([item("q1", "queued")], [wanted("q1", 1)]);
  const intents = fakeIntents([{ id: "q1", state: "queued" }]);
  const store = fakeStore(run);
  const out = applyProposal(intents, store, "run_7", { rows: ["q1"] }, NOW);
  assert.equal(out.counts.requeued, 0);
  assert.equal(out.detail, "0 retired · 1 ranked · 0 posted",
    "a '0 put back' on a repo with nothing failed is noise in a line read once");
});

test("a failed row with a verdict nobody ticked is left alone", () => {
  const run = runOver([item("f1", "failed")], [wanted("f1", 1)]);
  const intents = fakeIntents([{ id: "f1", state: "failed" }]);
  const store = fakeStore(run);
  const out = applyProposal(intents, store, "run_7", { rows: [] }, NOW);
  assert.deepEqual(intents.calls, ["kick"],
    "nothing applies itself — and a look at the list is not an application of anything");
  assert.equal(out.counts.requeued, 0);
});

// ── 5. one kick, and it is the LAST thing the apply does ────────────────────

test("N re-queues ask the ladder to look ONCE, after the approved ranks are written", () => {
  // The nineteen-row apply, in miniature. Every `requeueFailed` used to kick on
  // its way out; a kick runs a pass synchronously as far as its first `await`,
  // so row 1 was fired with rows 2 and 3 still terminal, its own rank unwritten,
  // and a candidate list of ONE — which `smartpick.hold()` refuses to think
  // about, so the pick the repo is ticked for never happened either.
  const run = runOver(
    [item("f1", "failed"), item("f2", "failed"), item("f3", "failed")],
    [wanted("f1", 3), wanted("f2", 1), wanted("f3", 2)],
  );
  const intents = fakeIntents([
    { id: "f1", state: "failed" }, { id: "f2", state: "failed" }, { id: "f3", state: "failed" },
  ]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["f1", "f2", "f3"] }, NOW);

  assert.equal(out.counts.requeued, 3);
  assert.equal(intents.calls.filter((c) => c === "kick").length, 1, "one look, not one per row");
  assert.equal(intents.calls[intents.calls.length - 1], "kick",
    "…and it is the last call: the ladder sees every revived row AND every rank the person approved");
  // The ranks the pass will sort by are on the rows before anything is told to
  // look at them — the whole reason the kick moved.
  assert.deepEqual([1, 2, 3].map((n) => intents.rows.get(`f${n}`).order), [3, 1, 2]);
});

// ── 6. which failure the run was looking at ────────────────────────────────

test("a row that has failed AGAIN since the run is skipped, uncounted, and does not fail the apply", () => {
  // Failed at 1000 when the run read the list; failed again at 2000 while the
  // sheet sat open. The state guard says "yes, failed" to that — it is the same
  // state and a different failure, and re-running on the strength of the old one
  // retires a sentence nobody has read.
  const run = runOver(
    [item("f1", "failed", { failedAt: 1000 }), item("f2", "failed", { failedAt: 1000 })],
    [wanted("f1", 1), wanted("f2", 2)],
  );
  const intents = fakeIntents([
    { id: "f1", state: "failed", settledAt: 2000 },
    { id: "f2", state: "failed", settledAt: 1000 },
  ]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["f1", "f2"] }, NOW);

  assert.equal(out.ok, true, "one skip must not take the rest of the apply with it");
  assert.deepEqual(intents.calls, ["requeue:f2:assess:run_7", "edit:f1:1", "edit:f2:2", "kick"],
    "the row that failed again is not even asked about — nothing is written on it");
  assert.equal(out.counts.requeued, 1);
  assert.equal(intents.rows.get("f1").state, "failed", "it stays failed, carrying the failure somebody has to read");
  // Still RANKED: the rank is a statement about where it sits in the list and is
  // true of a failed row as of a queued one. Only the revival is withheld.
  assert.equal(intents.rows.get("f1").order, 1);
});

test("a snapshot with no `failedAt` is applied on the state alone, exactly as before the field", () => {
  // Every proposal written by an older build, and every row that settled without
  // a stamp. Absence is never a refusal — it is the fact not having been written.
  const run = runOver([item("f1", "failed")], [wanted("f1", 1)]);
  const intents = fakeIntents([{ id: "f1", state: "failed", settledAt: 2000 }]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["f1"] }, NOW);
  assert.equal(out.counts.requeued, 1);
  assert.equal(intents.rows.get("f1").state, "queued");
});

test("the run STAMPS which failure it read, and only on the rows that had one", () => {
  // The other half of the comparison above: nothing to compare against unless
  // the document says which failure it was written about. Stamped on failed rows
  // only — `applyAssessment` never puts anything else on the requeue list, and a
  // `done` row's `settledAt` under a name that says "failed" is a fact about a
  // different question.
  const rows = [
    { id: "f1", cwd: CWD, state: "failed", settledAt: 1000, createdAt: 1, payload: { kind: "prompt", steps: ["fix it"] } },
    { id: "q1", cwd: CWD, state: "queued", createdAt: 2, payload: { kind: "prompt", steps: ["do it"] } },
    { id: "d1", cwd: CWD, state: "done", settledAt: 900, createdAt: 3, payload: { kind: "prompt", steps: ["did it"] } },
  ];
  const input = buildAssessInput(CWD, rows, [], NOW);
  const at = (id) => input.items.find((i) => i.id === id);
  assert.equal(at("f1").failedAt, 1000);
  assert.equal(at("q1").failedAt, undefined, "a row that has not settled has no failure to name");
  assert.equal(at("d1").failedAt, undefined, "and a finished one is context, judged about nothing");
});

// ── 7. The names ────────────────────────────────────────────────────────────
//
// The apply's one write that a person READS rather than one the ladder acts on,
// and the only place in this app where a machine's words go on top of a
// person's. Four rules, and the first is the whole feature:
//
//  • a `hand` field is NEVER written over, and the two halves are decided
//    separately — a row whose title somebody typed can still take a kind;
//  • `counts.named` is what was WRITTEN, not what was offered, so a run whose
//    every suggestion was refused reports none;
//  • `N titled` joins the detail line only when N is non-zero, which is
//    `requeued`'s rule for `requeued`'s reason;
//  • a POSTED row (a merge, a new item) carries its title as `assess` whatever
//    `writeNames` said, and carries NO `merge of N: …` label — that string was
//    machine bookkeeping in the field that means "the name a person gave this".

const named = (id, headline, category) => ({ id, verdict: "wanted", evidence: "still the next thing", rank: 1, headline, category });

test("titles are written through name(), and a hand field is left exactly as it was", () => {
  const run = runOver(
    [item("q1", "queued"), item("q2", "queued")],
    [named("q1", "picker loses its scroll", "bug"), named("q2", "write the migration guide", "chore")],
  );
  const intents = fakeIntents([
    // q1's title is the person's. Its KIND is nobody's, which is the ordinary
    // case and the reason the halves are asked separately.
    { id: "q1", state: "queued", headline: "MY OWN TITLE", headlineBy: "hand" },
    { id: "q2", state: "queued" },
  ]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["q1", "q2"], writeNames: true }, NOW);

  assert.equal(out.ok, true);
  assert.equal(intents.rows.get("q1").headline, "MY OWN TITLE", "a title somebody typed survives the apply untouched");
  assert.equal(intents.rows.get("q1").headlineBy, "hand", "…and still says who wrote it");
  assert.equal(intents.rows.get("q1").category, "bug", "…while the kind nobody had set is written");
  assert.equal(intents.rows.get("q1").categoryBy, "assess");
  assert.equal(intents.rows.get("q2").headline, "write the migration guide");
  assert.equal(intents.rows.get("q2").headlineBy, "assess");
  assert.equal(out.counts.named, 2, "both rows took SOMETHING, so both are counted");
});

test("a row whose every field is a person's is offered nothing and counts as nothing", () => {
  const run = runOver([item("q1", "queued")], [named("q1", "a title nobody asked for", "bug")]);
  const intents = fakeIntents([
    { id: "q1", state: "queued", headline: "MINE", headlineBy: "hand", category: "chore", categoryBy: "hand" },
  ]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["q1"], writeNames: true }, NOW);

  assert.equal(intents.rows.get("q1").headline, "MINE");
  assert.equal(intents.rows.get("q1").category, "chore");
  assert.equal(out.counts.named, 0, "nothing was written, so nothing is counted — the count is not 'we had opinions'");
  assert.equal(out.detail, "0 retired · 1 ranked · 0 posted", "…and the line says nothing about titles");
});

test("`N titled` joins the detail only when something was titled", () => {
  const run = runOver([item("q1", "queued")], [named("q1", "picker loses its scroll", "bug")]);
  const intents = fakeIntents([{ id: "q1", state: "queued" }]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["q1"], writeNames: true }, NOW);
  assert.equal(out.detail, "0 retired · 1 ranked · 0 posted · 1 titled");
});

test("without `writeNames` no existing row is titled at all", () => {
  // Absent is no — the behaviour every apply had before the question existed,
  // which is what makes an older client's apply a no-op here rather than a
  // silent yes.
  const run = runOver([item("q1", "queued")], [named("q1", "picker loses its scroll", "bug")]);
  const intents = fakeIntents([{ id: "q1", state: "queued" }]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["q1"] }, NOW);
  assert.equal(out.counts.named, 0);
  assert.equal(intents.rows.get("q1").headline, undefined);
  assert.ok(!intents.calls.some((c) => c.startsWith("name:")), "name() is not even called");
});

test("a posted merge carries its own title as `assess` — and no `merge of` label", () => {
  const run = {
    runId: "run_7", repoDir: CWD, status: "done",
    input: { items: [item("m1", "queued"), item("m2", "queued")] },
    proposal: {
      rows: [
        { id: "m1", verdict: "merged", evidence: "two facets of one job" },
        { id: "m2", verdict: "merged", evidence: "two facets of one job" },
      ],
      merges: [{
        gid: "g1", ids: ["m1", "m2"], prompt: "One prompt covering both facets.",
        rank: 2, rationale: "two facets of one job",
        headline: "picker keeps scroll and focus", category: "bug",
      }],
      news: [], notes: [],
    },
  };
  // `writeNames` is deliberately NOT set: a posted row has no typed words for a
  // title to stand on top of, so its name travels whatever the answer was.
  const intents = fakeIntents([{ id: "m1", state: "queued" }, { id: "m2", state: "queued" }]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { merges: ["g1"] }, NOW);

  assert.equal(out.counts.posted, 1);
  const post = [...intents.rows.values()].find((r) => r.origin === "assess:run_7");
  assert.ok(post, "the merge posted a row");
  assert.equal(post.headline, "picker keeps scroll and focus");
  assert.equal(post.headlineBy, "assess", "stamped by the run, so a naming pass may replace it and a person's tap wins over it");
  assert.equal(post.category, "bug");
  assert.equal(post.categoryBy, "assess");
  assert.equal(post.label, "from an assessment");
  assert.ok(!/merge of/.test(post.label), "the ids are on the run's proposal, not in the field that means 'what a person called this'");
});

// ── 8. A pad note the run said was still worth doing ────────────────────────
//
// The verdict that used to do nothing. A retiring verdict on a note is still
// informational — the pad is a synced document this host does not own — but
// *still worth doing* is now an OFFER, and applying it posts an ordinary
// backlog row carrying the note's own words (`AssessNew.fromNote`, synthesised
// by `cleanAssessment` from the item's own text).
//
// Three things about the apply, and the first is the one that is invisible in
// review:
//
//  • the posted row wears NO `label`. `from an assessment` is true of a merge
//    and of a genuinely new item; over a sentence a person typed it is a lie,
//    and `itemHeadline` lets a non-derived label beat the headline, so it would
//    sit above their own words as a title claiming a machine wrote them;
//  • nothing on the pad is touched — no `dismiss` ever names a note, and this
//    side never reads or writes `myapp.pad`. The note's clearing is the phone's,
//    on the receipt for the post;
//  • the detail says `N filed from the pad`, beside the existing count of the
//    notes that were judged and left on it.

const NOTE_WORDS = "a thought written on a train, in the person's own words";

/** A run whose proposal offers one pad note, the way `cleanAssessment` builds
 *  it: the words are the item's, copied. */
const runOffering = (over = {}) => ({
  runId: "run_7", repoDir: CWD, status: "done",
  input: { items: [{ id: "n1", source: "note", text: NOTE_WORDS }] },
  proposal: {
    rows: [{ id: "n1", verdict: "wanted", evidence: "", rank: 1, headline: "the train thought", category: "feature" }],
    merges: [],
    news: [{
      prompt: NOTE_WORDS, rank: 1, fromNote: "n1",
      headline: "the train thought", category: "feature",
    }],
    notes: [],
  },
  ...over,
});

test("a ticked offer posts the note's words, with no `label` over them", () => {
  const intents = fakeIntents([]);
  const out = applyProposal(intents, fakeStore(runOffering()), "run_7", { news: [0] }, NOW);

  assert.equal(out.ok, true);
  assert.equal(out.counts.posted, 1);
  const post = [...intents.rows.values()].find((r) => r.origin === "assess:run_7");
  assert.ok(post, "the offer posted a row");
  assert.deepEqual(post.payload.steps, [NOTE_WORDS],
    "the row runs the note's own sentence, byte for byte — nothing restated it");
  assert.equal(post.label, undefined,
    "no `from an assessment` over words a person typed: `itemHeadline` would show it as their title");
  assert.equal(post.headline, "the train thought");
  assert.equal(post.headlineBy, "assess", "the machine's half is still stamped as the machine's");
  assert.equal(post.category, "feature");
  assert.equal(post.categoryBy, "assess");
  assert.equal(post.order, 1, "…at the place the assessment gave it");
});

test("nothing on the pad is touched: no dismiss ever names a note", () => {
  const intents = fakeIntents([]);
  applyProposal(intents, fakeStore(runOffering()), "run_7", { news: [0], rows: ["n1"] }, NOW);
  assert.ok(!intents.calls.some((c) => c.startsWith("dismiss:") || c.startsWith("cancel:")),
    `the note is read and judged, never edited: ${JSON.stringify(intents.calls)}`);
});

test("the detail says what was filed from the pad, and only when something was", () => {
  const intents = fakeIntents([]);
  const out = applyProposal(intents, fakeStore(runOffering()), "run_7", { news: [0] }, NOW);
  assert.equal(out.detail, "0 retired · 0 ranked · 1 posted · 1 filed from the pad");

  // …and an offer nobody ticked says nothing at all about the pad. Nothing
  // applies itself, so an untouched sheet is an apply that did nothing.
  const quiet = fakeIntents([]);
  const none = applyProposal(quiet, fakeStore(runOffering()), "run_7", {}, NOW);
  assert.equal(none.detail, "0 retired · 0 ranked · 0 posted");
});

test("a retiring verdict on a note is still counted and left on the pad", () => {
  // The other half of the same fact, and the one that was already true: the
  // sheet shows the verdict, the count says how many were judged and left, and
  // the host edits nothing.
  const run = {
    runId: "run_7", repoDir: CWD, status: "done",
    input: { items: [{ id: "n1", source: "note", text: NOTE_WORDS }, { id: "n2", source: "note", text: "another" }] },
    proposal: {
      rows: [
        { id: "n1", verdict: "done", evidence: "src/train.ts:12 — it is there" },
        { id: "n2", verdict: "obsolete", evidence: "that screen is gone" },
      ],
      merges: [], news: [], notes: [],
    },
  };
  const intents = fakeIntents([]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { rows: ["n1", "n2"] }, NOW);
  assert.equal(out.counts.dismissed, 0, "a note is not a row this host can retire");
  assert.equal(out.detail, "0 retired · 0 ranked · 0 posted · 2 pad notes judged and left on the pad");
});

test("both pad clauses can be true of one apply, and the filing is said first", () => {
  const run = runOffering({
    input: {
      items: [
        { id: "n1", source: "note", text: NOTE_WORDS },
        { id: "n2", source: "note", text: "a thought that is already done" },
      ],
    },
  });
  run.proposal.rows.push({ id: "n2", verdict: "done", evidence: "src/x.ts:1 — shipped" });
  const intents = fakeIntents([]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { news: [0], rows: ["n2"] }, NOW);
  assert.equal(out.detail,
    "0 retired · 0 ranked · 1 posted · 1 filed from the pad · 1 pad note judged and left on the pad");
});

// ── 9. …and the RECEIPT for those posts, which is where words were lost ──────
//
// The phone owns the pad; the host owns the backlog. So clearing a filed note
// is the one pad delete in this app that happens on a REMOTE receipt rather
// than on a durable local copy — and therefore the one that can lose words.
//
// `intents.post` refuses on its own (`PENDING_MAX`, a draft that could never
// run) and this loop does `if (!r.ok) continue`, so an apply where NOT ONE row
// landed still answers `{ok: true}`. The `op.ack` carried counts and no ids, so
// a phone clearing every ticked offer on that `ok` tombstoned three notes with
// no row anywhere to show for them.
//
// `AssessApplyOutcome.filed` is the fix: the `fromNote` ids that ACTUALLY
// posted, collected past the refusal check, out on `op.ack` as `filed?:
// string[]`. The phone clears `ticked ∩ filed`. **Absent means this host cannot
// tell you, so assume nothing was filed**; `[]` is the opposite claim.

/** A run offering TWO pad notes, so a PARTIAL refusal is visible at all. */
const runOfferingTwo = () => ({
  runId: "run_7", repoDir: CWD, status: "done",
  input: {
    items: [
      { id: "n1", source: "note", text: NOTE_WORDS },
      { id: "n2", source: "note", text: "a second thought, also the person's" },
    ],
  },
  proposal: {
    rows: [
      { id: "n1", verdict: "wanted", evidence: "", rank: 1 },
      { id: "n2", verdict: "wanted", evidence: "", rank: 2 },
    ],
    merges: [],
    news: [
      { prompt: NOTE_WORDS, rank: 1, fromNote: "n1" },
      { prompt: "a second thought, also the person's", rank: 2, fromNote: "n2" },
    ],
    notes: [],
  },
});

test("a host that refuses every post files NOTHING, and says so in the ids", () => {
  // The severe case, exactly as reported: three offers ticked at a host sitting
  // on its pending cap. `ok` is still true — the apply did everything it was
  // asked and the retirements happened — so `ok` cannot be what a delete rests
  // on.
  const intents = fakeIntents([], { refusePost: () => true });
  const out = applyProposal(intents, fakeStore(runOfferingTwo()), "run_7", { news: [0, 1] }, NOW);

  assert.equal(out.ok, true, "an apply whose posts were refused is not a failed apply");
  assert.equal(out.counts.posted, 0);
  assert.deepEqual(out.filed, [],
    "…and the receipt SAYS nothing landed, which is what stops two notes being cleared");
  assert.ok(!out.detail.includes("filed from the pad"),
    `nothing was filed, so the sentence claims nothing: ${out.detail}`);
});

test("a PARTIALLY refused apply names only the notes whose row landed", () => {
  const intents = fakeIntents([], { refusePost: (d) => d.payload.steps[0].startsWith("a second") });
  const out = applyProposal(intents, fakeStore(runOfferingTwo()), "run_7", { news: [0, 1] }, NOW);

  assert.equal(out.counts.posted, 1);
  assert.deepEqual(out.filed, ["n1"],
    "the id of the row that exists, and only that one — `n2`'s words are still the last copy");
  assert.equal(out.detail, "0 retired · 0 ranked · 1 posted · 1 filed from the pad");
});

test("`filed` is PRESENT and empty whenever the posts ran — absent is a different claim", () => {
  // Present-and-empty says "this host can tell you, and nothing was filed".
  // Absent says "this host cannot tell you" — an older daemon, or a guard that
  // refused before the posts. The phone reads them differently, so an apply
  // that got as far as the loop must never answer absent.
  const quiet = applyProposal(fakeIntents([]), fakeStore(runOffering()), "run_7", {}, NOW);
  assert.deepEqual(quiet.filed, [], "nobody ticked the offer, but the posts still ran");

  const ordinary = applyProposal(fakeIntents([]), fakeStore(runOffering()), "run_7", { news: [0] }, NOW);
  assert.deepEqual(ordinary.filed, ["n1"]);

  // The guards, which answer before anything is posted: they cannot say.
  const gone = applyProposal(fakeIntents([]), { get: () => undefined, recordApplied() {} }, "run_7", {}, NOW);
  assert.equal(gone.ok, false);
  assert.equal(gone.filed, undefined, "a run that is gone filed nothing and claims nothing");

  const twice = applyProposal(fakeIntents([]), fakeStore({ ...runOffering(), status: "applied", applied: { dismissed: 0, ranked: 0, posted: 1 } }), "run_7", { news: [0] }, NOW);
  assert.equal(twice.ok, false);
  assert.equal(twice.filed, undefined,
    "an already-applied run cannot say WHICH notes the first apply filed, so it says nothing");
});

test("a post that is not from a note is never named in `filed`", () => {
  // `posted` counts every post; `filed` counts one kind. A genuinely new item
  // the run invented has no note behind it, and naming it would have the phone
  // look for a note it is about to delete by id.
  const run = runOffering();
  run.proposal.news.push({ prompt: "something the run thought of itself", rank: 2 });
  const intents = fakeIntents([]);
  const out = applyProposal(intents, fakeStore(run), "run_7", { news: [0, 1] }, NOW);
  assert.equal(out.counts.posted, 2);
  assert.deepEqual(out.filed, ["n1"]);
  assert.equal(out.detail, "0 retired · 0 ranked · 2 posted · 1 filed from the pad");
});
