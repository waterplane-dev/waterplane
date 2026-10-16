/**
 * The assessment view model, pinned without a browser.
 *
 * `assessRows.ts` lives in `packages/web/src` because it is the phone's
 * selector, but it has no DOM in it and no clock of its own, so it runs the way
 * `activityRows.test.mjs` runs: `node --test`, straight over the TypeScript,
 * using node's own type stripping.
 *
 * What is worth pinning here is not the arrangement — it is the four rules that
 * decide whether a tap on this screen is safe, every one of which fails
 * SILENTLY:
 *
 *   • a merge card that shows a COUNT instead of the originals, or clips the
 *     prompt, is a person approving text they did not read;
 *   • an accept that is offered where `applyAssessment` will do nothing is a
 *     tick that vanishes — the user's decision, silently discarded;
 *   • a bulk confirmation that does not name the repo and show real prompts is
 *     "31 rows", which nobody can check — and one that says a different VERB
 *     than the button that opened it puts the word this screen was rebuilt to
 *     stop using back in the last sentence before the tap;
 *   • a count on a control that opens a different number is a badge that lies,
 *     and the truth living in a `title` is the truth being invisible on a phone;
 *   • an apply blocker in the wrong order tells a person to fix their tunnel
 *     when what they actually have to do is tick a row.
 *
 * None of those throws and none shows up in a type-check.
 *
 *     node --test packages/web/src/assessRows.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSESS_SAMPLE,
  assessApplyNote,
  assessCutLabel,
  assessOpenBacklogLabel,
  assessOpenBacklogNote,
  assessReadyCut,
  ASSESS_MISSING_BLOCKED,
  assessAcceptBlocker,
  assessApplyBlocker,
  assessApplyLabel,
  assessApplySummary,
  assessBulkLines,
  assessBulkWords,
  assessDowngradeTally,
  assessGroups,
  assessGuide,
  assessMergeLines,
  assessMissingWords,
  assessNewItemNote,
  assessPickedCount,
  assessPickedLabel,
  assessRetires,
  assessRowHead,
  assessRunBlocker,
  assessAcceptWords,
  assessAppliedWords,
  assessRowPosition,
  assessElapsed,
  assessStepCounts,
  assessStepVerb,
  assessWatch,
  ASSESS_QUIET_MS,
  LEAVE_WORDS,
  NEW_ITEM_WORDS,
  ASSESS_NOTE_OFFERED,
  NOTE_ITEM_WORDS,
  assessNoteItemNote,
  assessNotesFiledWords,
  assessFiledSplit,
  assessFiledWords,
} from "./assessRows.ts";
// The sheet decides whether a row names a picture with the SAME reader the
// thumbnail strip resolves it with — one question, one answer.
import { refsIn } from "./fileRefs.ts";
// The naming question's words are `@waterplane/shared`'s, for `assessPinQuestion`'s
// reason: the host says the same thing back and a second wording is a second
// answer.
import { ASSESS_NAME_SKIP, ASSESS_NAME_WRITE, assessNameNote, assessNameQuestion } from "@waterplane/shared";

const item = (id, over = {}) => ({ id, source: "intent", text: `the words of ${id}`, ...over });
const row = (id, verdict, over = {}) => ({ id, verdict, evidence: "src/a.ts:12", ...over });
const proposal = (over = {}) => ({ rows: [], merges: [], news: [], notes: [], ...over });
const groupOf = (gs, v) => gs.find((g) => g.verdict === v);

// ── Grouping and order ──────────────────────────────────────────────────────

test("strips come back in the shared verdict order, and empty ones are dropped", () => {
  const gs = assessGroups(
    proposal({ rows: [row("a", "wanted"), row("b", "done"), row("c", "unclear")] }),
    [item("a"), item("b"), item("c")],
  );
  assert.deepEqual(gs.map((g) => g.verdict), ["done", "wanted", "unclear"]);
});

test("wanted is ordered by rank — the whole content of that verdict", () => {
  const gs = assessGroups(
    proposal({ rows: [row("a", "wanted", { rank: 3 }), row("b", "wanted", { rank: 1 }), row("c", "wanted", { rank: 2 })] }),
    [item("a"), item("b"), item("c")],
  );
  assert.deepEqual(groupOf(gs, "wanted").rows.map((r) => r.id), ["b", "c", "a"]);
});

test("a verdict that retires something opens; one that changes nothing you would want back does not", () => {
  const gs = assessGroups(
    proposal({ rows: [row("a", "done"), row("b", "wanted"), row("c", "unclear")] }),
    [item("a"), item("b"), item("c")],
  );
  assert.equal(groupOf(gs, "done").defaultOpen, true);
  assert.equal(groupOf(gs, "wanted").defaultOpen, false);
  assert.equal(groupOf(gs, "unclear").defaultOpen, false);
  assert.equal(assessRetires("done"), true);
  assert.equal(assessRetires("wanted"), false);
});

test("the merge strip never collapses", () => {
  const gs = assessGroups(
    proposal({
      rows: [row("a", "merged", { gid: "g1" }), row("b", "merged", { gid: "g1" })],
      merges: [{ gid: "g1", ids: ["a", "b"], prompt: "do the one job", rationale: "two facets" }],
    }),
    [item("a"), item("b")],
  );
  const g = groupOf(gs, "merged");
  assert.equal(g.fixedOpen, true);
  assert.equal(groupOf(gs, "merged").merges.length, 1);
});

// ── The words ───────────────────────────────────────────────────────────────

test("a row carries the item's own words in FULL, never clipped", () => {
  const long = "x".repeat(5000);
  const gs = assessGroups(proposal({ rows: [row("a", "done")] }), [item("a", { text: long })]);
  assert.equal(groupOf(gs, "done").rows[0].text, long);
  assert.equal(groupOf(gs, "done").rows[0].missing, false);
});

test("an id this device has no words for is a row that SAYS so — never hidden, never a bare id, and never a live tick", () => {
  const gs = assessGroups(proposal({ rows: [row("ghost", "done")] }), []);
  const r = groupOf(gs, "done").rows[0];
  assert.equal(r.missing, true);
  assert.equal(r.text, "");
  assert.equal(r.id, "ghost");
  // The row and the host read ONE record (`run.input.items`), so an id with no
  // words here is an id `applyAssessment` skips — which is what
  // `assessApplySummary` has always counted. A live `retire it` on it was a
  // tick that went nowhere.
  assert.equal(r.acceptBlocked, ASSESS_MISSING_BLOCKED);
  assert.match(r.acceptBlocked, /a tick would do nothing/);
  assert.equal(assessMissingWords("ghost"), "the words for “ghost” are not on this phone");
  assert.doesNotMatch(ASSESS_MISSING_BLOCKED, /applying still works/, "the promise this replaced");
  // ...and the strip's bulk button cannot cover it either.
  assert.equal(groupOf(gs, "done").acceptable, 0);
});

test("the row's sentence is the shared module's, and a downgrade is flagged as well as worded", () => {
  const gs = assessGroups(
    proposal({ rows: [{ id: "a", verdict: "unclear", evidence: "half of it exists", downgraded: "no-evidence" }] }),
    [item("a")],
  );
  const r = groupOf(gs, "unclear").rows[0];
  assert.equal(r.downgraded, "no-evidence");
  assert.match(r.sentence, /nothing was cited/);
  // The evidence the CLI did manage to give is kept in the same sentence.
  assert.match(r.sentence, /half of it exists/);
});

test("a superseded row carries the words of the item said to cover it", () => {
  const gs = assessGroups(
    proposal({ rows: [row("a", "superseded", { supersededBy: "b" })] }),
    [item("a"), item("b", { text: "the item that covers it" })],
  );
  assert.equal(groupOf(gs, "superseded").rows[0].supersededByText, "the item that covers it");
});

// ── Merges: the highest-stakes card ─────────────────────────────────────────

test("a merge card carries ALL N originals in full, plus the ids it was built from", () => {
  const long = "y".repeat(3000);
  const gs = assessGroups(
    proposal({
      rows: [row("a", "merged", { gid: "g1" }), row("b", "merged", { gid: "g1" }), row("c", "merged", { gid: "g1" })],
      merges: [{ gid: "g1", ids: ["a", "b", "c"], prompt: long, rationale: "one job" }],
    }),
    [item("a"), item("b", { text: long }), item("c")],
  );
  const card = groupOf(gs, "merged").merges[0];
  assert.equal(card.prompt, long, "the proposed prompt is never clipped");
  assert.equal(card.originals.length, 3, "all N originals, not a count");
  assert.equal(card.originals[1].text, long, "an original is never clipped either");
  assert.deepEqual(card.ids, ["a", "b", "c"]);
  assert.deepEqual(card.missingIds, []);
});

test("the merged strip has no rows of its OWN — the card is where its items are drawn", () => {
  const gs = assessGroups(
    proposal({
      rows: [row("a", "merged", { gid: "g1" }), row("b", "merged", { gid: "g1" })],
      merges: [{ gid: "g1", ids: ["a", "b"], prompt: "the one job", rationale: "two facets" }],
    }),
    [item("a"), item("b")],
  );
  const g = groupOf(gs, "merged");
  assert.equal(g.rows.length, 0, "drawn as rows too, every original appeared twice — once with a dead button");
  assert.equal(g.count, 2, "the head counts ITEMS, not cards");
  assert.deepEqual(g.merges[0].originals.map((o) => o.id), ["a", "b"], "and the card still resolves both in full");
  assert.equal(g.merges[0].originals[1].text, "the words of b");
});

test("every other strip's count is its rows", () => {
  const gs = assessGroups(
    proposal({ rows: [row("a", "done"), row("b", "done"), row("c", "wanted")] }),
    [item("a"), item("b"), item("c")],
  );
  assert.equal(groupOf(gs, "done").count, 2);
  assert.equal(groupOf(gs, "wanted").count, 1);
});

test("a merge naming an id this device has no words for says which", () => {
  const gs = assessGroups(
    proposal({
      rows: [row("a", "merged", { gid: "g1" })],
      merges: [{ gid: "g1", ids: ["a", "gone"], prompt: "one job", rationale: "" }],
    }),
    [item("a")],
  );
  assert.deepEqual(groupOf(gs, "merged").merges[0].missingIds, ["gone"]);
});

// ── What a tap may mean ─────────────────────────────────────────────────────

test("accepting says why it would do nothing, rather than doing nothing", () => {
  // `applyAssessment`'s rules, said out loud.
  assert.match(assessAcceptBlocker("unclear", "intent"), /did not decide about this one/);
  assert.match(assessAcceptBlocker("merged", "intent"), /one decision about all of its items/);
  assert.equal(assessAcceptBlocker("wanted", "intent"), null);
  assert.equal(assessAcceptBlocker("done", "intent"), null);
});

test("words this phone does not have are refused before anything about the store", () => {
  // `source` on such a row is `assessGroups`'s fallback and not a fact — there
  // is no item to read it off — so the missing sentence outranks every other.
  for (const v of ["done", "obsolete", "superseded", "wanted", "unclear", "merged"]) {
    assert.equal(assessAcceptBlocker(v, "intent", true), ASSESS_MISSING_BLOCKED, `${v} with no words`);
  }
  assert.equal(assessAcceptBlocker("done", "note", true), ASSESS_MISSING_BLOCKED, "before the pad's own sentence");
  assert.equal(assessAcceptBlocker("done", "intent", false), null, "and a row we DO hold is untouched by it");
});

test("a pad note is refused whatever the verdict — the host never edits the pad", () => {
  // `applyProposal`: `if (d.source === "note") { notes++; continue; }`. An
  // accept offered here is a tick that vanishes, which is a decision taken and
  // thrown away.
  for (const v of ["done", "obsolete", "superseded", "wanted"]) {
    assert.match(assessAcceptBlocker(v, "note"), /never edit/, `${v} on a note`);
  }
  assert.match(assessAcceptBlocker("done", "note"), /delete it on the pad/, "and where the tap that finishes it is");
  assert.equal(assessAcceptBlocker("done", "intent"), null, "a backlog item is still acceptable");
});

test("a note the run still WANTS points at the offer instead of closing the row", () => {
  // `cleanAssessment` synthesises an offer in `proposal.news` from the note's
  // own text, so this is the one note verdict with somewhere to go. Still a
  // refusal — accepting HERE does nothing — but it now says where the tick is.
  assert.equal(assessAcceptBlocker("wanted", "note"), ASSESS_NOTE_OFFERED);
  assert.match(ASSESS_NOTE_OFFERED, /offered below/);
  assert.match(ASSESS_NOTE_OFFERED, /in its own words/);
  assert.match(ASSESS_NOTE_OFFERED, /never edited by this app/, "the pad promise survives the new branch");
  // Every other verdict on a note is untouched by it.
  for (const v of ["done", "obsolete", "superseded", "unclear"]) {
    assert.notEqual(assessAcceptBlocker(v, "note"), ASSESS_NOTE_OFFERED, `${v} is not offered`);
  }
  // And a MISSING row still outranks it: there is no offer for words this run's
  // own record does not hold.
  assert.equal(assessAcceptBlocker("wanted", "note", true), ASSESS_MISSING_BLOCKED);
});

test("an offer is worded as the person's words, never as the run's", () => {
  // Two cards can sit side by side, one holding words a model wrote and one
  // holding words the user wrote. If they read the same, the whole point of
  // copying the note verbatim is lost.
  assert.equal(NOTE_ITEM_WORDS.label, "file it");
  assert.equal(NOTE_ITEM_WORDS.picked, "will be filed");
  assert.notEqual(NOTE_ITEM_WORDS.label, NEW_ITEM_WORDS.label);
  assert.notEqual(NOTE_ITEM_WORDS.picked, NEW_ITEM_WORDS.picked);
  // FUTURE tense, this file's rule: `Apply` is the only thing that acts.
  assert.match(NOTE_ITEM_WORDS.picked, /^will be /);
  // What the tap does, and how to change your mind — both titles present, and
  // the first says the pad half out loud.
  assert.match(NOTE_ITEM_WORDS.title, /Apply/);
  assert.match(NOTE_ITEM_WORDS.title, /off the pad/);
  assert.match(NOTE_ITEM_WORDS.pickedTitle, /change your mind/);
});

test("the offer's effect line promises the pad clear as a SEQUENCE, not a simultaneity", () => {
  const note = assessNoteItemNote("myapp");
  assert.match(note, /word for word/, "verbatim is the guarantee");
  assert.match(note, /backlog item in myapp/);
  // "once the desktop has it" — the host never touches the pad, so the clear
  // rides on the receipt. A sentence claiming both happen together would be a
  // promise a dead socket breaks.
  assert.match(note, /once the desktop has it/);
  assert.notEqual(note, assessNewItemNote("myapp"));
});

test("the receipt for a filed note says both halves, singular and plural apart", () => {
  assert.equal(assessNotesFiledWords(1), "your note is on the backlog and off the pad");
  assert.equal(assessNotesFiledWords(3), "3 notes are on the backlog and off the pad");
  for (const n of [1, 2, 3]) {
    assert.match(assessNotesFiledWords(n), /on the backlog/, "the row landed");
    assert.match(assessNotesFiledWords(n), /off the pad/, "and the words are not in two places");
  }
});

test("a strip's acceptable count is what a bulk accept would actually cover", () => {
  const gs = assessGroups(
    proposal({ rows: [row("a", "wanted"), row("b", "wanted"), row("c", "unclear")] }),
    [item("a"), item("b", { source: "note" }), item("c")],
  );
  assert.equal(groupOf(gs, "wanted").acceptable, 1, "the pad note has no order to be moved to");
  assert.equal(groupOf(gs, "unclear").acceptable, 0);
});

// ── The confirmations ───────────────────────────────────────────────────────

test("a bulk confirmation names the repo, counts, and shows three REAL prompts", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id, text: `prompt ${id}`, verdict: "done" }));
  const lines = assessBulkLines(rows, { repoName: "myapp", verdict: "done" });
  assert.ok(lines.some((l) => l.includes("myapp")), "the repo is named");
  assert.ok(lines.some((l) => l.includes("5")), "the count is stated");
  for (const id of ["a", "b", "c"]) {
    assert.ok(lines.some((l) => l.includes(`prompt ${id}`)), `a real prompt (${id}) is shown`);
  }
  assert.equal(lines.filter((l) => l.startsWith("“")).length, ASSESS_SAMPLE);
  assert.ok(lines.some((l) => l.includes("…and 2 more")));
  assert.ok(lines.some((l) => /Nothing is deleted/.test(l)), "the sentence that makes the button allowed");
});

test("a merge confirmation says the prompt is not yours, and what it replaces", () => {
  const card = {
    gid: "g1", prompt: "the merged prompt", rationale: "one job", ids: ["a", "b"],
    originals: [{ id: "a", text: "words a" }, { id: "b", text: "words b" }], missingIds: [],
  };
  const lines = assessMergeLines(card, { repoName: "myapp" });
  assert.ok(lines.some((l) => l.includes("myapp")));
  assert.ok(lines.some((l) => l.includes("the merged prompt")));
  assert.ok(lines.some((l) => l.includes("words a")) && lines.some((l) => l.includes("words b")));
  assert.ok(lines.some((l) => /not by you/.test(l)));
});

// ── Why a button cannot be pressed ──────────────────────────────────────────

const runOf = (over = {}) => ({
  runId: "r1", repoDir: "/dev/myapp", status: "done", startedAt: 1,
  proposal: proposal({ rows: [row("a", "done")] }), ...over,
});

test("apply refuses in the order a person can act on", () => {
  assert.match(assessApplyBlocker({ run: null, picked: 0, online: true }), /no assessment/);
  assert.match(assessApplyBlocker({ run: runOf({ status: "running" }), picked: 2, online: true }), /still running/);
  assert.match(assessApplyBlocker({ run: runOf({ status: "applied" }), picked: 2, online: true }), /already been applied/);
  assert.match(assessApplyBlocker({ run: runOf({ proposal: proposal() }), picked: 0, online: true }), /nothing to decide/);
  // Ticking a row is something a tap fixes; the tunnel is not — so the tick
  // comes first even when both are true.
  assert.match(assessApplyBlocker({ run: runOf(), picked: 0, online: false }), /nothing is ticked yet/);
  assert.match(assessApplyBlocker({ run: runOf(), picked: 2, online: false }), /no connection/);
  assert.equal(assessApplyBlocker({ run: runOf(), picked: 2, online: true }), null);
});

test("one assessment at a time per repo outranks every other refusal", () => {
  assert.match(assessRunBlocker({ run: runOf({ status: "running" }), online: false, budgetNote: "the budget is spent" }), /already running/);
  assert.match(assessRunBlocker({ run: runOf(), online: true, budgetNote: "the budget is spent" }), /budget is spent/);
  assert.match(assessRunBlocker({ run: runOf(), online: false }), /no connection/);
  assert.equal(assessRunBlocker({ run: runOf(), online: true }), null);
  assert.equal(assessRunBlocker({ run: null, online: true }), null);
});

// ── Reading the undecided pile ──────────────────────────────────────────────

test("the unclear strip is tallied by WHY, commonest first, in the shared words", () => {
  const rows = [
    { downgraded: "no-evidence" }, { downgraded: "no-evidence" }, { downgraded: "unmentioned" },
    { downgraded: undefined },
  ];
  const tally = assessDowngradeTally(rows);
  assert.deepEqual(tally.map((t) => [t.down, t.n]), [["no-evidence", 2], ["unmentioned", 1]]);
  assert.match(tally[0].text, /nothing was cited/);
});

test("the ticked count is every kind of decision, not just the rows — and says TICKED", () => {
  assert.equal(assessPickedCount({ rows: new Set(["a"]), merges: new Set(["g1"]), news: new Set([0, 1]) }), 4);
  // `4 accepted` under a screen whose every control stopped saying "accept",
  // about four things that have not happened: Apply is what acts.
  assert.equal(assessPickedLabel(4), "4 ticked");
  assert.doesNotMatch(assessPickedLabel(4), /accepted/);
});

// ── Watching a run happen ────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const running = (over = {}) => ({ runId: "as_1", repoDir: "/r", status: "running", startedAt: NOW - 60_000, ...over });
const progress = (over = {}) => ({ tail: [], steps: 0, tools: 0, at: NOW, ...over });
const step = (over = {}) => ({ at: NOW, kind: "read", label: "Read", detail: "src/a.ts", ...over });

test("elapsed keeps the seconds while seconds are what is happening", () => {
  assert.equal(assessElapsed(0), "0s");
  assert.equal(assessElapsed(42_000), "42s");
  assert.equal(assessElapsed(252_000), "4m 12s");
  assert.equal(assessElapsed(300_000), "5m");
  assert.equal(assessElapsed(3_900_000), "1h 5m");
});

test("a step reads as the verb it was", () => {
  assert.equal(assessStepVerb(step()), "reading src/a.ts");
  assert.equal(assessStepVerb(step({ kind: "search", label: "Grep", detail: "runAssessment" })), "searching for runAssessment");
  assert.equal(assessStepVerb(step({ kind: "run", label: "Bash", detail: "git log" })), "running git log");
  assert.equal(assessStepVerb(step({ kind: "say", label: "said", detail: "…" })), "thinking it over");
});

test("an unknown tool reads as ITSELF, never as nothing", () => {
  assert.equal(assessStepVerb(step({ kind: "tool", label: "SomeLaterTool", detail: "a value" })), "SomeLaterTool: a value");
  assert.equal(assessStepVerb(step({ kind: "tool", label: "SomeLaterTool", detail: undefined })), "SomeLaterTool");
});

test("only a running run is watched", () => {
  assert.equal(assessWatch(null, NOW), null);
  assert.equal(assessWatch(running({ status: "done" }), NOW), null);
});

test("a run nobody has heard from yet is STARTING UP, not silent", () => {
  const w = assessWatch(running(), NOW);
  assert.equal(w.doing, "starting up", "an older host sends no progress at all — that is not a failure");
  assert.equal(w.elapsed, "1m");
  assert.equal(w.counts, undefined);
});

test("the headline is the last thing it was seen doing", () => {
  const w = assessWatch(running({ progress: progress({ tail: [step(), step({ kind: "search", label: "Grep", detail: "assess" })], steps: 2, tools: 2 }) }), NOW);
  assert.equal(w.doing, "searching for assess");
  assert.equal(w.counts, "2 steps");
});

test("the tail says it is a tail", () => {
  const w = assessWatch(running({ progress: progress({ tail: [step(), step()], steps: 61, tools: 60 }) }), NOW);
  assert.equal(w.counts, "61 steps · last 2 shown", "a list showing 2 of 61 must not read as a run that did 2 things");
});

test("the live chip and the settled run's button count one thing, and the button names what it OPENS", () => {
  // `212 steps` on a control that opens 24 rows, with "the last 24 of 212" in a
  // `title` nobody on a phone can see: a count on a control is a filter, and it
  // says what it opens. Both readings come from this one call now.
  const cut = assessStepCounts(212, 24);
  assert.equal(cut.line, "212 steps · last 24 shown");
  assert.equal(cut.button, "last 24 of 212 steps");

  const whole = assessStepCounts(7, 7);
  assert.equal(whole.line, "7 steps");
  assert.equal(whole.button, "7 steps", "showing all of them, there is no cut to name");
  assert.equal(assessStepCounts(1, 1).button, "1 step");

  // The tail is a fact this device holds; the count came off the host. A host
  // that sends 0 beside twenty events must not label the button "0 steps".
  assert.equal(assessStepCounts(0, 20).button, "20 steps");
  assert.equal(assessStepCounts(212, 0).button, "212 steps");

  // ...and the live panel is built from the same call, so they cannot drift.
  const w = assessWatch(running({ progress: progress({ tail: [step(), step()], steps: 61, tools: 60 }) }), NOW);
  assert.equal(w.counts, assessStepCounts(61, 2).line);
});

test("writing the answer outranks the step that is doing it", () => {
  const w = assessWatch(running({ progress: progress({ tail: [step({ kind: "edit", label: "Write", detail: ".myapp/assess-out.json" })], steps: 9, tools: 9, wroteOut: true }) }), NOW);
  assert.equal(w.doing, "writing its answer");
});

test("a quiet run says HOW quiet, and never that it is stuck", () => {
  const quiet = assessWatch(running({ progress: progress({ tail: [step()], steps: 1, tools: 1, at: NOW - ASSESS_QUIET_MS - 30_000 }) }), NOW);
  assert.equal(quiet.quiet, "nothing new for 2m");
  const busy = assessWatch(running({ progress: progress({ tail: [step()], steps: 1, tools: 1, at: NOW - 5_000 }) }), NOW);
  assert.equal(busy.quiet, undefined, "a run that answered five seconds ago says nothing about silence");
});

// ── What accepting DOES ──────────────────────────────────────────────────────

test("accept names the EFFECT, per verdict — never the verb", () => {
  const retire = assessAcceptWords("done", "intent");
  assert.equal(retire.label, "retire it");
  assert.match(retire.title, /words are kept/);
  assert.match(retire.effect, /nothing is implemented/, "the confusion this answers is 'will it go and build it?'");
  assert.equal(assessAcceptWords("obsolete", "intent").label, "retire it");
  assert.equal(assessAcceptWords("superseded", "intent").label, "retire it");
});

test("a kept item says it takes a position and starts nothing", () => {
  const w = assessAcceptWords("wanted", "intent");
  assert.equal(w.label, "keep it");
  assert.match(w.title, /does not run it/);
});

test("a ticked row is FUTURE tense — Apply is the only thing that has acted", () => {
  for (const v of ["done", "obsolete", "superseded"]) {
    const w = assessAcceptWords(v, "intent");
    assert.equal(w.picked, "will be retired", `${v} ticked`);
    assert.doesNotMatch(w.picked, /accepted/, "past tense on a thing that has not happened is the bug");
  }
  const kept = assessAcceptWords("wanted", "intent");
  assert.equal(kept.picked, "will be kept");
  assert.doesNotMatch(kept.picked, /accepted/);
  assert.match(assessAcceptWords("done", "intent").pickedTitle, /change your mind/);
});

test("leaving a row alone is an answer, and the one label that is not a promise", () => {
  assert.equal(LEAVE_WORDS.label, "leave it");
  assert.equal(LEAVE_WORDS.picked, "left alone");
  assert.match(LEAVE_WORDS.pickedTitle, /un-mark/);
});

// ── The strip's own button ───────────────────────────────────────────────────

const stripOf = (verdict, rows, over = {}) => ({
  verdict,
  label: verdict,
  rows,
  merges: [],
  count: rows.length,
  acceptable: rows.filter((r) => !r.acceptBlocked).length,
  failed: verdict === "wanted" ? rows.filter((r) => !r.acceptBlocked && r.failed).length : 0,
  retires: verdict !== "wanted" && verdict !== "unclear",
  defaultOpen: true,
  fixedOpen: false,
  ...over,
});
const free = (id) => ({ id, acceptBlocked: null });

const myapp = { repoName: "myapp" };

test("a bulk button names the verdict's own effect, and only the retiring one confirms", () => {
  const retire = assessBulkWords(stripOf("done", [free("a"), free("b"), free("c")]), 0, myapp);
  assert.equal(retire.label, "retire all 3");
  assert.equal(retire.confirm, true);
  assert.match(retire.title, /words are kept/, "the sentence that makes the button allowed to exist");
  assert.match(retire.title, /nothing is implemented/, "the confusion this whole screen answers");
  assert.match(retire.title, /3 of the items first/, "and that the confirmation shows real prompts");

  const keep = assessBulkWords(stripOf("wanted", [free("a"), free("b")]), 0, myapp);
  assert.equal(keep.label, "keep all 2");
  assert.equal(keep.confirm, false, "a confirm on a harmless button teaches tapping through the ones that matter");
});

test("the dialog says the verb the BUTTON said, never the word the screen stopped using", () => {
  // `retire all 3` opening "Accept 3 “done” in myapp?" is this whole change
  // undone one screen later: "accept" is the word nobody could interpret.
  const retire = assessBulkWords(stripOf("done", [free("a"), free("b"), free("c")]), 0, myapp);
  assert.equal(retire.ask.title, "Retire 3 “done” in myapp?", "the repo, the count and the verdict — and the button's own verb");
  assert.equal(retire.ask.confirmLabel, "Retire 3");
  assert.ok(retire.label.startsWith("retire"), "one verb, one source");
  for (const s of [retire.ask.title, retire.ask.confirmLabel]) assert.doesNotMatch(s, /Accept|accept/);

  // No dialog ⇒ no dialog words. A `Keep N` nothing renders is a string nobody
  // maintains; flip `confirm` and it arrives with it.
  const keep = assessBulkWords(stripOf("wanted", [free("a"), free("b")]), 0, myapp);
  assert.equal(keep.ask, undefined);
  assert.equal(assessBulkWords(stripOf("done", [free("a")]), 1, myapp).ask, undefined, "and un-ticking asks nothing");
});

test("with the whole strip ticked the same button takes the marks off", () => {
  const w = assessBulkWords(stripOf("done", [free("a"), free("b"), free("c")]), 3, myapp);
  assert.equal(w.label, "un-tick 3");
  assert.equal(w.confirm, false, "nothing has been applied, so nothing is undone");
});

test("a strip with no acceptable tap has no bulk button at all — never a dead one", () => {
  assert.equal(assessBulkWords(stripOf("merged", []), 0, myapp), null, "a merge is approved on its own card");
  assert.equal(assessBulkWords(stripOf("unclear", [{ id: "a", acceptBlocked: "nothing to accept" }]), 0, myapp), null);
  assert.equal(assessBulkWords(stripOf("done", [{ id: "a", acceptBlocked: "a pad note" }]), 0, myapp), null, "every row blocked ⇒ nothing to cover");
});

// ── The line above the words ─────────────────────────────────────────────────

const headRow = (over = {}) => ({ id: "i1", source: "intent", text: "the whole sentence somebody wrote", missing: false, ...over });

test("the row head never shows the 40-char cut of the words as a name", () => {
  const text = "For this and all other things that need doing before the release, read the notes";
  const cut = text.slice(0, 40);
  assert.equal(assessRowHead(headRow({ text, label: cut })).name, undefined, "add() fills label with text.slice(0, 40)");
  assert.equal(assessRowHead(headRow({ text, label: "release prep" })).name, "release prep", "a name somebody typed is a name");
  assert.equal(assessRowHead(headRow({ text })).name, undefined);
});

test("the head says which store, and prints an id only where it is the only handle", () => {
  assert.equal(assessRowHead(headRow()).kind, "backlog item");
  assert.equal(assessRowHead(headRow({ source: "note" })).kind, "pad note");
  assert.equal(assessRowHead(headRow()).id, undefined, "an id over a sentence is a database key over words");
  assert.equal(assessRowHead(headRow({ missing: true, text: "" })).id, "i1", "with no words, the id is all there is");
});

test("the head is titled by the run, and SAYS the title is the run's", () => {
  // `itemHeadline`'s order, on this screen: a name somebody typed wins, and the
  // run's stands where they put nothing. `suggested` is what earns the row the
  // `Sparkles` mark — a person has to be able to tell at a glance whether the
  // line they are reading is their own, which is the whole reason the author
  // travels with the name at all.
  const mine = assessRowHead(headRow({ label: "release prep", headline: "the release notes" }));
  assert.equal(mine.headline, "release prep", "a typed name is never displaced by a machine's");
  assert.equal(mine.suggested, false);

  const theirs = assessRowHead(headRow({ headline: "flaky upload test" }));
  assert.equal(theirs.headline, "flaky upload test");
  assert.equal(theirs.suggested, true);

  // Nothing at all is nothing at all — never the id, never the first words.
  const bare = assessRowHead(headRow());
  assert.equal(bare.headline, undefined);
  assert.equal(bare.suggested, false);

  // The kind is drawn only where the run gave one. Absent means the run said
  // nothing (`naming.ts`), and a default bucket here would be this screen
  // inventing a claim in the one place its whole job is not to.
  assert.equal(assessRowHead(headRow({ category: "bug" })).category, "bug");
  assert.equal(bare.category, undefined);

  // **`kind` survives only where there is no headline.** *backlog item* over a
  // list of backlog items is the weakest thing the head can say; where it is
  // still the only thing there — an unnamed pad note, whose accept is refused
  // and whose refusal is about that store — it is still there.
  assert.equal(assessRowHead(headRow({ source: "note" })).headline, undefined, "an unnamed note keeps its word");
  assert.equal(assessRowHead(headRow({ source: "note" })).kind, "pad note");
});

// ── What the screen IS ───────────────────────────────────────────────────────

test("the guide says what nothing does, and names the plan only when there is one", () => {
  const g = assessGuide({ repoName: "myapp", judged: 62 });
  // The lead is the half that is ALWAYS on screen, so it carries the two claims
  // that have to be read before the first tap — and it stays one line: it was
  // three, on top of a head that had already spent five rows on chrome.
  assert.match(g.lead, /proposal/i);
  assert.match(g.lead, /builds, runs or sends anything/, "the question asked was 'run someone for implementation?'");
  assert.ok(g.lead.length <= 60, `the lead must fit one line on a phone; it is ${g.lead.length} chars`);
  // Who wrote it, about how many of whose items, is worth a tap — not the screen.
  assert.ok(g.lines.some((l) => /myapp/.test(l) && /62 items you wrote/.test(l)));
  assert.ok(g.lines.some((l) => /not a to-do list/.test(l)));
  assert.ok(g.lines.some((l) => /Nothing happens yet/.test(l)));
  assert.ok(g.lines.some((l) => /only thing that changes anything/.test(l)), "where the one acting tap is");
  assert.ok(g.lines.some((l) => /brings one back/.test(l)), "and that being wrong is recoverable");
  assert.equal(g.lines.some((l) => /read the plan/.test(l)), false, "no plan file ⇒ no sentence about one");

  const withPlan = assessGuide({ repoName: "myapp", judged: 1, planPath: ".myapp/plan.md" });
  assert.ok(withPlan.lines.some((l) => /1 item you wrote/.test(l)));
  assert.ok(withPlan.lines.some((l) => l.includes(".myapp/plan.md") && /not something to run/.test(l)));
});

// ── What Apply is about to do ────────────────────────────────────────────────

test("the apply label restates the whole decision and omits the zero parts", () => {
  const p = proposal({ rows: [row("a", "done"), row("b", "done"), row("c", "wanted", { rank: 1 })] });
  const items = [item("a"), item("b"), item("c")];
  const retireOnly = assessApplySummary(p, { rows: ["a", "b"], merges: [], news: [] }, items);
  assert.deepEqual(retireOnly, { retire: 2, keep: 0, requeue: 0, post: 0, name: 0 });
  assert.equal(assessApplyLabel(retireOnly, "myapp"), "Apply in myapp — retire 2");

  const all = assessApplySummary(p, { rows: new Set(["a", "b", "c"]), merges: new Set(), news: new Set() }, items);
  assert.deepEqual(all, { retire: 2, keep: 1, requeue: 0, post: 0, name: 0 });
  assert.equal(assessApplyLabel(all, "myapp"), "Apply in myapp — retire 2 · keep 1 in order");
});

test("a merge counts its members once, however many of their rows were also ticked", () => {
  const p = proposal({
    rows: [row("a", "merged", { gid: "g1" }), row("b", "merged", { gid: "g1" })],
    merges: [{ gid: "g1", ids: ["a", "b"], prompt: "the one job", rationale: "two facets" }],
    news: [{ prompt: "the missing piece" }],
  });
  const s = assessApplySummary(p, { rows: ["a", "b"], merges: ["g1"], news: [0] }, [item("a"), item("b")]);
  assert.deepEqual(s, { retire: 2, keep: 0, requeue: 0, post: 2, name: 0 }, "two members, one merged prompt and one new one");
  assert.equal(assessApplyLabel(s, "myapp"), "Apply in myapp — retire 2 · post 2 new");
});

test("what the host will not do is not counted", () => {
  const p = proposal({ rows: [row("n", "done"), row("w", "wanted"), row("u", "unclear"), row("ghost", "done")] });
  const s = assessApplySummary(
    p,
    { rows: ["n", "w", "u", "ghost"], merges: [], news: [] },
    [item("n", { source: "note" }), item("w"), item("u")],
  );
  assert.deepEqual(s, { retire: 0, keep: 0, requeue: 0, post: 0, name: 0 },
    "a pad note is left alone, a wanted row with no rank has no position to take, unclear decides nothing, and an id this device has no item for is not the host's to touch");
  assert.equal(assessApplyLabel(s, "myapp"), "Apply in myapp");
});

test("the note under Apply says both halves: nothing lost, nothing built", () => {
  assert.match(assessApplyNote(0), /brought back/);
  assert.match(assessApplyNote(0), /Nothing is built or sent/);
  assert.equal(NEW_ITEM_WORDS.picked, "will be posted");
  assert.match(assessNewItemNote("myapp"), /backlog item in myapp/);
  assert.match(assessNewItemNote("myapp"), /its own session when it fires/);
});

// ── The gate the thumbnail strip hangs off ───────────────────────────────────

test("an item naming a screenshot is recognised as one, by the sheet's own reader", () => {
  // The sheet and the strip must ask ONE question about "does this item name a
  // picture", or a row shows a thumbnail the tap cannot open (or the reverse).
  const refs = refsIn("Go and implement all requirements from the screenshot .claude/inbox/1000074690-mtmw2965bdb334.jpg");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].relPath, ".claude/inbox/1000074690-mtmw2965bdb334.jpg");
  assert.equal(refs[0].image, true);
});

// ── A `still wanted` verdict on a row that FAILED ────────────────────────────
//
// The rule this whole section pins: a failed row is terminal, so approving
// "still wanted" on one cannot be a position — it has to be a return to the
// queue. Before it, the sheet promised "position 1 in the order" and the apply
// did nothing at all, on a repo whose backlog was 0 queued and 19 failed. Every
// assertion below is a sentence a person reads before a tap, which is why they
// are pinned rather than reasoned about.

const failedItem = (id, over = {}) => item(id, { state: "failed", ...over });

test("a failed item's row says so, and a queued one does not", () => {
  const gs = assessGroups(
    proposal({ rows: [row("a", "wanted", { rank: 1 }), row("b", "wanted", { rank: 2 })] }),
    [failedItem("a"), item("b", { state: "queued" })],
  );
  const rows = groupOf(gs, "wanted").rows;
  assert.equal(rows.find((r) => r.id === "a").failed, true);
  assert.equal(rows.find((r) => r.id === "b").failed, false);
  // It is read off the ITEM's state and nothing else — the same field
  // `applyAssessment` reads, so the phone cannot word the fact differently.
  assert.equal(assessGroups(proposal({ rows: [row("c", "wanted")] }), [item("c")])[0].rows[0].failed, false,
    "a host that sends no state at all ranks, exactly as every apply did before this existed");
  assert.equal(groupOf(gs, "wanted").failed, 1, "and the strip counts the ones a bulk tap would put back");
});

test("the position line says what Apply will actually do to the row's place", () => {
  assert.equal(assessRowPosition({ verdict: "wanted", rank: 1, failed: false }), "position 1 in the order");
  assert.equal(assessRowPosition({ verdict: "wanted", rank: 1, failed: true }), "put back in the queue, position 1");
  assert.equal(assessRowPosition({ verdict: "wanted", failed: true }), "put back in the queue",
    "a re-queue needs no rank — the row takes its turn where it lies");
  assert.equal(assessRowPosition({ verdict: "wanted", failed: false }), null);
  assert.equal(assessRowPosition({ verdict: "done", rank: 1, failed: true }), null, "only `wanted` is about a place");
});

test("a failed row's accept names the effect it actually has — put it back, not keep it", () => {
  const w = assessAcceptWords("wanted", "intent", true);
  assert.equal(w.label, "put it back");
  assert.equal(w.picked, "will be put back in the queue");
  assert.doesNotMatch(w.picked, /put back in the queue\./, "future tense, like every other ticked label");
  assert.match(w.title, /back in the queue at the position the run proposes/);
  // WHERE it runs is the row's own fact and this document cannot see it —
  // `AssessItem` carries the words, the state and the failure instant, never
  // the target — so the sentence names both outcomes instead of asserting the
  // one that is wrong for every row aimed at a session.
  assert.match(w.title, /runs again where it was already aimed — a session of its own, or the session it names/);
  assert.doesNotMatch(w.title, /in a session of its own when its turn comes/);
  assert.match(w.title, /the failure it had stays on the row/, "reviving a row must not read as wiping its history");
  // The strip's line has to cover BOTH kinds of `wanted` row, because a strip
  // holding one failed row holds ranked ones too.
  assert.match(w.effect, /goes back in the queue/);
  assert.match(w.effect, /nothing is started now/);
  // …and with no failed row on it, the old sentence, unchanged.
  assert.equal(assessAcceptWords("wanted", "intent", false).label, "keep it");
  assert.equal(assessAcceptWords("wanted", "intent").label, "keep it", "absent means the row is in the queue already");
});

test("a keep that REVIVES asks first, and the dialog names both numbers", () => {
  const strip = stripOf("wanted", [
    { id: "a", acceptBlocked: null, failed: true },
    { id: "b", acceptBlocked: null, failed: true },
    { id: "c", acceptBlocked: null, failed: false },
  ]);
  const w = assessBulkWords(strip, 0, myapp);
  assert.equal(w.label, "keep all 3");
  assert.equal(w.confirm, true, "this one tap puts work back on a desktop");
  assert.equal(w.ask.title, "Keep 3 in myapp — put 2 back in the queue?");
  assert.equal(w.ask.confirmLabel, "Keep 3");
  // The button's title says the same thing in one sentence, before the dialog.
  assert.match(w.title, /2 of them failed/);
  assert.match(w.title, /each where it was already aimed — a session of its own, or the session it names/);
  assert.doesNotMatch(w.title, /each in a session of its own/);
  assert.match(w.title, /nothing is started now/);
  // A plain re-sort still does not confirm — a confirm on a harmless button is
  // what teaches people to tap through the ones that matter.
  assert.equal(assessBulkWords(stripOf("wanted", [free("a"), free("b")]), 0, myapp).confirm, false);
});

test("the confirmation over failed rows says what happens, and what does not", () => {
  const rows = [
    { id: "a", text: "the first one", failed: true },
    { id: "b", text: "the second one", failed: true },
    { id: "c", text: "the third one", failed: false },
  ];
  const lines = assessBulkLines(rows, { repoName: "myapp", verdict: "wanted" });
  const all = lines.join("\n");
  assert.match(all, /2 of them failed/, "the count is off the rows the tap covers, never passed in");
  assert.match(all, /one at a time in this repo/);
  assert.match(all, /each where it was already aimed — a session of its own, or the session it names/);
  assert.doesNotMatch(all, /each in a session of its own/);
  assert.match(all, /stays on the row/);
  assert.match(all, /Nothing is retired/);
  assert.doesNotMatch(all, /This only sets the order they run in/,
    "the promise that stopped being true the moment a keep could revive a row");
  // With nothing failed it is the sentence it always was.
  const plain = assessBulkLines([{ id: "a", text: "x", failed: false }], { repoName: "myapp", verdict: "wanted" }).join("\n");
  assert.match(plain, /This only sets the order they run in/);
});

test("requeue is its own count, disjoint from keep, and the button says it in words", () => {
  const p = proposal({
    rows: [row("f", "wanted", { rank: 1 }), row("q", "wanted", { rank: 2 }), row("n", "wanted")],
  });
  const s = assessApplySummary(
    p,
    { rows: ["f", "q", "n"], merges: [], news: [] },
    [failedItem("f"), item("q"), failedItem("n")],
  );
  assert.deepEqual(s, { retire: 0, keep: 1, requeue: 2, post: 0, name: 0 },
    "a ranked failed row is counted once, as the thing that changes what happens next; a failed row with no rank still counts");
  assert.equal(assessApplyLabel(s, "myapp"), "Apply in myapp — keep 1 in order · put 2 back in the queue");
  // The order is retire · keep · put back · post, and a zero part is dropped
  // rather than printed as a decision about nothing.
  assert.equal(
    assessApplyLabel({ retire: 3, keep: 2, requeue: 1, post: 4, name: 0 }, "myapp"),
    "Apply in myapp — retire 3 · keep 2 in order · put 1 back in the queue · post 4 new",
  );
  // A pad note and a context row are still nobody's to revive.
  const skipped = assessApplySummary(
    proposal({ rows: [row("note", "wanted"), row("ctx", "wanted")] }),
    { rows: ["note", "ctx"], merges: [], news: [] },
    [item("note", { source: "note", state: "failed" }), item("ctx", { context: true, state: "failed" })],
  );
  assert.equal(skipped.requeue, 0);
});

test("the note under Apply stops promising nothing runs, once something will", () => {
  const none = assessApplyNote(0);
  assert.match(none, /Nothing is built or sent by this/, "unchanged for an apply that retires and re-sorts");
  const some = assessApplyNote(19);
  assert.match(some, /brought back/, "the half that is always true");
  assert.doesNotMatch(some, /Nothing is built or sent by this/,
    "a flat promise that nothing runs is one this apply cannot keep");
  assert.match(some, /Nothing is started now/);
  assert.match(some, /the 19 put back run again when their turn comes/);
  assert.match(some, /one at a time per repo/);
  assert.match(some, /each where it was already aimed — a session of its own, or the session it names/);
  assert.doesNotMatch(some, /each in a session of its own/);
  assert.match(assessApplyNote(1), /the one put back runs again when its turn comes/);
});

test("the guide's Apply line covers the kept row that had failed", () => {
  const g = assessGuide({ repoName: "myapp", judged: 19 });
  const apply = g.lines.find((l) => l.startsWith("Apply,"));
  assert.match(apply, /a kept item that had failed is put back in the queue/);
  assert.match(apply, /runs again when its turn comes/);
  assert.match(apply, /old failure kept on the row/);
});

test("an applied run reports the fourth count, and omits it when there is none", () => {
  assert.equal(
    assessAppliedWords({ dismissed: 12, ranked: 3, posted: 1, requeued: 19 }),
    "applied: 12 retired · 3 ranked · 19 put back · 1 posted",
  );
  assert.equal(
    assessAppliedWords({ dismissed: 12, ranked: 3, posted: 1 }),
    "applied: 12 retired · 3 ranked · 1 posted",
    "an older run carries no such count, and `0 put back` would be a claim about a decision nobody made",
  );
  assert.equal(
    assessAppliedWords({ dismissed: 0, ranked: 0, posted: 0, requeued: 0 }),
    "applied: 0 retired · 0 ranked · 0 posted",
  );
});

// ── The naming half of an apply ─────────────────────────────────────────────

test("the naming question is the shared module's, and is asked about ITEMS", () => {
  // `assessPinQuestion`'s rule: the host words the same decision on its own
  // side, so a second wording here is how two screens come to disagree about
  // what was decided. Pinned by shape rather than paraphrased.
  assert.equal(
    assessNameQuestion(14),
    "This run wrote a title or a kind for 14 items. Should they go on the rows?",
  );
  assert.equal(assessNameQuestion(1), "This run wrote a title or a kind for 1 item. Should they go on the rows?");
  // The write side says the protection out loud — it is the only thing standing
  // between a naming run and words somebody typed — and the skip side does not
  // say "nothing happens": the suggestions are still on the sheet.
  assert.match(assessNameNote(true), /never replaced/);
  assert.match(assessNameNote(false), /stay on this sheet/);
  assert.equal(ASSESS_NAME_WRITE, "write them");
  assert.equal(ASSESS_NAME_SKIP, "leave the rows as they are");
});

test("the summary counts the rows this apply would TITLE, and the host's own rules decide which", () => {
  const p = proposal({
    rows: [
      row("a", "done", { headline: "the flaky upload test" }),
      row("b", "wanted", { rank: 1, category: "bug" }),
      row("c", "wanted", { rank: 2 }),                            // the run said nothing about it
      row("n", "done", { headline: "a note" }),                   // a pad note: never edited here
      row("ghost", "done", { headline: "not on this phone" }),    // no item ⇒ not the host's to touch
    ],
  });
  const items = [item("a"), item("b"), item("c"), item("n", { source: "note" })];
  // **Independent of the ticks**: naming is one answer to one question about
  // the whole run, and "I do not agree this is done" is not "do not call it
  // that". Nothing is ticked here and the count is still two.
  const s = assessApplySummary(p, { rows: [], merges: [], news: [] }, items);
  assert.equal(s.name, 2, "the pad note and the id nobody holds are not the host's to name");
  // …and independent of the SWITCH, so the number means the same thing in both
  // answers. What the switch decides is whether the button says it.
  assert.equal(assessApplyLabel(s, "myapp", { writeNames: false }), "Apply in myapp");
  assert.equal(assessApplyLabel(s, "myapp", { writeNames: true }), "Apply in myapp — title 2");
  // Last in the line, after the three parts that change what RUNS: a title is a
  // label on work that is going to happen either way.
  assert.equal(
    assessApplyLabel({ retire: 3, keep: 2, requeue: 1, post: 4, name: 5 }, "myapp", { writeNames: true }),
    "Apply in myapp — retire 3 · keep 2 in order · put 1 back in the queue · post 4 new · title 5",
  );
  // Absent `writeNames` is the behaviour every apply had before the question
  // existed, which is what an older caller must keep getting.
  assert.equal(assessApplyLabel({ retire: 1, keep: 0, requeue: 0, post: 0, name: 9 }, "myapp"), "Apply in myapp — retire 1");
});

// ── The footer restates BOTH questions ──────────────────────────────────────

test("the apply label carries the ranking answer whenever there is an order to have an opinion about", () => {
  // The regression this pins: the two questions live at the END OF THE SCROLL,
  // so they can be scrolled past. The footer cannot be, and it restated the
  // naming answer and said nothing at all about pin-ranks — a person could
  // Apply having never met the decision about whether the order is marked as
  // theirs.
  const s = { retire: 0, keep: 3, requeue: 0, post: 1, name: 0 };
  assert.equal(
    assessApplyLabel(s, "myapp", { ranked: 4, pinRanks: true }),
    "Apply in myapp — keep 3 in order · post 1 new · order pinned",
  );
  // **Both answers are said, never only the non-default one.** `order free` is
  // as much a decision as `order pinned`, and a part that shows up for one
  // answer only reports a choice as an exception.
  assert.equal(
    assessApplyLabel(s, "myapp", { ranked: 4, pinRanks: false }),
    "Apply in myapp — keep 3 in order · post 1 new · order free",
  );
  // `ranked` is what decides the question is ASKED (`AssessSheet`'s `rankedN`),
  // so it is what decides the answer is restated: with nothing to order, the
  // control is not drawn and the label must not claim a decision was made.
  assert.equal(
    assessApplyLabel({ retire: 2, keep: 0, requeue: 0, post: 0, name: 0 }, "myapp", { ranked: 0, pinRanks: true }),
    "Apply in myapp — retire 2",
  );
  // Absent answers are the behaviour every apply had before the questions
  // existed — an older caller keeps the label it always got.
  assert.equal(assessApplyLabel(s, "myapp"), "Apply in myapp — keep 3 in order · post 1 new");
  // Both halves together, in order: the parts that change what runs, then the
  // one that decides what may re-sort them, then the label on work that is
  // going to happen either way.
  assert.equal(
    assessApplyLabel(
      { retire: 3, keep: 2, requeue: 1, post: 4, name: 5 },
      "myapp",
      { ranked: 6, pinRanks: true, writeNames: true },
    ),
    "Apply in myapp — retire 3 · keep 2 in order · put 1 back in the queue · post 4 new · order pinned · title 5",
  );
  // …and the naming half on its own, which is the assertion finding 2 asks for:
  // the switch being on has to reach the LABEL, not merely the count.
  assert.equal(
    assessApplyLabel({ retire: 0, keep: 0, requeue: 0, post: 0, name: 7 }, "myapp", { writeNames: true }),
    "Apply in myapp — title 7",
  );
});

test("the applied receipt says what was titled, and omits a zero", () => {
  assert.equal(
    assessAppliedWords({ dismissed: 12, ranked: 3, posted: 1, named: 14 }),
    "applied: 12 retired · 3 ranked · 14 titled · 1 posted",
  );
  // `requeued`'s rule: `0 titled` reads as a claim that somebody decided about
  // titles, where the truth is that the run wrote none or the switch said no.
  assert.doesNotMatch(assessAppliedWords({ dismissed: 1, ranked: 0, posted: 0, named: 0 }), /titled/);
  assert.doesNotMatch(assessAppliedWords({ dismissed: 1, ranked: 0, posted: 0 }), /titled/);
});

test("the guide mentions the naming switch only when this run named something", () => {
  const none = assessGuide({ repoName: "myapp", judged: 62 });
  assert.equal(none.lines.some((l) => /switch at the bottom/.test(l)), false,
    "a sentence about a control that is not on the screen is worse than no sentence");
  const named = assessGuide({ repoName: "myapp", judged: 62, named: 14 });
  const line = named.lines.find((l) => /switch at the bottom/.test(l));
  assert.ok(line, "the switch is in the footer, and a decision first met at the bottom is one taken without reading");
  assert.match(line, /title and a kind/);
  assert.match(line, /never replaced/, "the protection is the reason it is cheap to say yes");
  assert.equal(named.lines.length, none.lines.length + 1, "one line, not a paragraph");
});

/**
 * **The route out of an applied assessment, and the rule that the number on it
 * is the cut it opens.**
 *
 * The complaint this answers is that applying a proposal ended the screen —
 * *"still no button to lead to the groomed backlog with the results where I
 * then can kick implementation off"*. What is worth pinning is not that a
 * button exists, it is the derivation, and it is pinned on two rules:
 *
 *   • it is taken from the LIVE backlog and not from the ticks, because
 *     `assessPicks.ts` drops the ticks ON APPLY and a reload drops them anyway
 *     — a route derived from them would say 4 before a reload and 0 after it,
 *     about the same list;
 *   • it is **the whole groomed backlog**, not this run's share of it. The
 *     share was what the button counted once, and *"4 waiting in myapp"* over a
 *     repo with seven waiting is a number that does not mean its own words:
 *     every `unclear` row is queued and was excluded by construction, and so
 *     was every retire-verdict row nobody ticked.
 */
const readyRun = (over = {}) => ({
  runId: "as_1", repoDir: "/r", status: "applied",
  applied: { dismissed: 2, ranked: 1, posted: 3 },
  proposal: {
    rows: [
      { id: "a", verdict: "wanted", rank: 1 },
      { id: "b", verdict: "wanted", rank: 2 },
      { id: "c", verdict: "done" },
    ],
    merges: [], news: [],
  },
  ...over,
});

test("the route counts what is WAITING in the repo, and the ids are that count", () => {
  const live = [
    // posted by this run
    { id: "p1", status: "queued" },
    // judged `wanted` and still waiting: kept, or put back
    { id: "a", status: "queued" },
    { id: "b", status: "queued" },
    // judged `wanted`, but the re-queue was refused (it settled again) — a row
    // nothing is going to pick up is not waiting for anybody
    { id: "z", status: "failed" },
    // judged `unclear`: queued, never `wanted`, and EXACTLY the row the old
    // derivation dropped while the button claimed to count what was waiting
    { id: "u", status: "queued" },
    // a row this run said nothing about — still waiting in this repo, so still
    // part of the backlog somebody is about to kick implementation off from
    { id: "x", status: "queued" },
  ];
  const cut = assessReadyCut(readyRun(), live);
  assert.deepEqual(cut.ids, ["p1", "a", "b", "u", "x"], "every non-archived queued/blocked row in the repo, in the list's own order");
  assert.equal(cut.n, cut.ids.length, "the number IS the cut — never a second count that has to agree");
  assert.equal(cut.ids.includes("u"), true, "an `unclear` row is queued and is waiting; excluding it made the number a lie");
  assert.equal(cut.ids.includes("z"), false, "a re-queue the host refused leaves the row failed, and failed is not waiting");
});

test("a started row and an archived one are not waiting", () => {
  const cut = assessReadyCut(readyRun(), [
    { id: "p1", status: "running" },
    { id: "p2", status: "queued", archived: true },
    { id: "p3", status: "done" },
    { id: "a", status: "starting" },
    { id: "b" },
  ]);
  assert.deepEqual(cut.ids, [], "nothing here is waiting for anybody");
  // The archived row is the one worth naming: archiving IS somebody saying a
  // row is not waiting, and the host's own `waiting()` skips it too.
  assert.equal(assessReadyCut(readyRun(), [{ id: "p2", status: "queued", archived: true }]).n, 0);
});

test("the route is drawn only on an apply, and never guesses", () => {
  const live = [{ id: "a", status: "queued" }];
  assert.equal(assessReadyCut(null, live).n, 0);
  // A run with a proposal but no `applied` is a PROPOSAL: counting "what is
  // waiting" there would be counting the backlog as it already was.
  assert.equal(assessReadyCut({ runId: "as_1", proposal: { rows: [], merges: [], news: [] } }, live).n, 0);
  assert.equal(assessReadyCut({ runId: "as_1" }, live).n, 0);
  assert.equal(assessReadyCut(readyRun(), []).n, 0, "an empty repo is an empty cut, not an error");
});

test("the route says where it goes and drops a zero rather than printing one", () => {
  // `N waiting in myapp` is now literally the number waiting in myapp — the cut
  // is the repo's whole waiting list, so the words and the number agree.
  assert.equal(assessOpenBacklogLabel(4, "myapp"), "open the backlog — 4 waiting in myapp");
  assert.equal(assessOpenBacklogLabel(1, "myapp"), "open the backlog — 1 waiting in myapp");
  // `0 waiting` reads as a claim about the apply rather than about the repo. A
  // number that reads as the wrong claim is not drawn; the route still is.
  assert.equal(assessOpenBacklogLabel(0, "myapp"), "open the backlog in myapp");
  assert.doesNotMatch(assessOpenBacklogLabel(0, "myapp"), /\b0\b/);
});

test("the route's sentence promises it changes nothing, and says what the cut is", () => {
  const some = assessOpenBacklogNote(3);
  assert.match(some, /those 3/, "a count on a control is a filter, and the sentence says so");
  assert.match(some, /everything waiting in this repo/, "and the sentence says WHICH rows those 3 are");
  assert.match(some, /already happened/, "this is a route, not a second mutation");
  // The zero case is a fact about the REPO. It said "nothing here is waiting
  // any more" while `unclear` rows waited — the same defect as the count.
  assert.match(assessOpenBacklogNote(0), /Nothing is waiting in this repo/);
  assert.match(assessOpenBacklogNote(0), /unfiltered/);
  assert.match(assessOpenBacklogNote(0), /Nothing else is applied/);
});

test("the filter bar's label says what the cut IS, and where it came from", () => {
  // `made from these` — the bar's fallback — says nothing at all. Naming only
  // the assessment would be the OLD cut's label on the new one: a bar reading
  // *from the assessment of myapp* over rows the assessment never judged.
  assert.equal(assessCutLabel("myapp"), "everything waiting in myapp, from the assessment");
  assert.match(assessCutLabel("myapp"), /waiting/, "what the cut is");
  assert.match(assessCutLabel("myapp"), /assessment/, "where the reader came from");
});

// ── Clearing a filed note ────────────────────────────────────────────
// The other half of a word-loss path, and the half that cannot be seen: the
// host's apply can post FEWER rows than were ticked (the pending cap, a draft
// it cannot run) and still answer `ok` with counts. Clearing on `ok` alone
// tombstoned notes against rows that do not exist — and a tombstone travels, so
// the other device does not put them back either.

test("only a note the ack PROVES was filed comes off the pad", () => {
  const split = assessFiledSplit(["a", "b", "c"], ["b"]);
  assert.deepEqual(split.clear, ["b"], "ticked AND filed");
  assert.deepEqual(split.stay, ["a", "c"], "ticked and not filed: still the only copy");
  assert.equal(split.told, true);
  // An id the host filed that nobody ticked here is none of this screen's
  // business — the intersection is the rule, not the host's list.
  assert.deepEqual(assessFiledSplit(["a"], ["a", "z"]).clear, ["a"]);
});

test("an ack that cannot say (an older desktop) clears NOTHING and says so", () => {
  const split = assessFiledSplit(["a", "b"], undefined);
  assert.deepEqual(split.clear, [], "no proof, no delete");
  assert.deepEqual(split.stay, ["a", "b"]);
  assert.equal(split.told, false);
  const said = assessFiledWords(split);
  assert.match(said, /could not say/, "the silence is reported, never guessed from a count");
  assert.match(said, /left on the pad/, "and the sentence says WHERE the words are");
  // Never worded as a failure: an already-applied replay under a fresh ackId
  // has rows on the backlog and an ack that cannot name them.
  assert.doesNotMatch(said, /fail|refus|error/i);
  // The singular is worded apart: this is the sentence that tells somebody
  // their own words did or did not move.
  assert.match(assessFiledWords(assessFiledSplit(["a"], undefined)), /your note is left on the pad/);
});

test("an empty `filed` is an ANSWER — nothing posted — and is not the same sentence", () => {
  const split = assessFiledSplit(["a", "b"], []);
  assert.equal(split.told, true, "`[]` is the host telling us it filed none of them");
  assert.deepEqual(split.clear, []);
  const said = assessFiledWords(split);
  assert.match(said, /nothing was filed/);
  assert.match(said, /still on the pad/);
  assert.doesNotMatch(said, /could not say/, "it CAN say; it said none");
});

test("a partial file says both halves, and never calls the rest filed", () => {
  const said = assessFiledWords(assessFiledSplit(["a", "b", "c"], ["a", "b"]));
  assert.match(said, /2 notes are on the backlog and off the pad/);
  assert.match(said, /1 is still on your pad/);
  assert.match(said, /did not file it/);
  // The all-landed case keeps the sentence it always had.
  assert.equal(assessFiledWords(assessFiledSplit(["a"], ["a"])), assessNotesFiledWords(1));
  assert.equal(assessFiledWords(assessFiledSplit(["a", "b"], ["a", "b"])), assessNotesFiledWords(2));
});

test("nothing ticked is nothing to say", () => {
  assert.equal(assessFiledWords(assessFiledSplit([], ["a"])), null);
  assert.equal(assessFiledWords(assessFiledSplit([], undefined)), null);
});
