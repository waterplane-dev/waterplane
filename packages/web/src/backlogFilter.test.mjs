/**
 * The backlog's status/age/ids cut.
 *
 * `backlogFilter.ts` is pure, so `node --test` runs it straight over the
 * TypeScript and `npm run test:unit` discovers it:
 *
 *     node --test packages/web/src/backlogFilter.test.mjs
 *
 * The case that matters is the one the repo keeps re-learning: a count on a
 * control is a filter, so a chip saying 3 must open exactly three rows —
 * including when the OTHER dimension is already filtering.
 *
 * A THIRD dimension arrived with the smart pick: `ids`, the cut behind
 * "merged from 3" on a row a grooming pass wrote. That is the sharpest version
 * of the same rule in the app — those three rows are ARCHIVED, so the default
 * view hides every one of them, and a tap that opened anything but exactly
 * those three would be the sheet asking the reader to work out by eye which
 * words the machine folded. Its half of this file is at the bottom.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NO_CATEGORY_LABEL, describeRule } from "@waterplane/shared";
import {
  BACKLOG_AGES, BACKLOG_STATUSES, DROP_CLOCK_TOAST, HOLD_FOR_HOST_TEXT, HOLD_FOR_HOST_TITLE, holdChipWords,
  NO_BACKLOG_FILTER,
  ageBucket, backlogCountWords, backlogCounts, backlogFilterSentence, clockGroupWords, clockGroups,
  clockSeat, clockSeatWords, itemClockKey, onClockIds, clockWords, dropClockNote,
  ASSESS_NONE_IN_CUT, archiveDoneLabel, archiveDoneNote, archiveDoneToast,
  assessScopeLabel, assessScopeNote, assessableInCut,
  CLOSED_TARGET_OPTION, NEW_SESSION_OPTION, editTargetOptions,
  dropClockTitle, dropClocksLabel, dropClocksNote, dropClocksToast, fmtSpan, goneOnClockLabel, hasBacklogFilter,
  FOCUS_AUTO_ON_LABEL, FOCUS_AUTO_ON_TITLE, focusRunWords,
  scheduleParentLabel,
  fromScheduleWords, hiddenByArchive, matchesBacklogFilter, onClockLabel, realLabel,
  scheduleItemsLabel,
  scheduleRuleLabel, smartWroteWords, undoOfferFor, undoWhileRunningWords, withinAge,
  RUN_AGAIN_LABEL, RUN_AGAIN_TOAST,
  requeuedWords, runAgainAimedCount, runAgainClosedNote, runAgainEligible, runAgainIds,
  runAgainLabel, runAgainNote, runAgainRowNote, runAgainState, runAgainToast,
  CATEGORY_CHIP_LABEL, HEADLINE_BY_WORDS, NAME_COST_NOTE,
  categoryBucket, categoryChipTitle, headlineEditHint, nameLabel, nameNote, nameableInCut, namingToast,
} from "./backlogFilter.ts";

const NOW = 1_700_000_000_000;
const H = 3600_000;
const item = (o) => ({ id: o.id ?? "x", text: o.text ?? "do a thing", status: o.status ?? "queued", repoDir: "/r", order: 0, createdAt: o.createdAt ?? NOW, ...o });

test("age buckets by the tightest window, and a future stamp is new, not old", () => {
  assert.equal(ageBucket(NOW - 60_000, NOW), "hour");
  assert.equal(ageBucket(NOW - 2 * H, NOW), "day");
  assert.equal(ageBucket(NOW - 30 * H, NOW), "week");
  assert.equal(ageBucket(NOW - 9 * 24 * H, NOW), "older");
  // A desktop whose clock moved forward: the newest row must not sort last.
  assert.equal(ageBucket(NOW + 5 * H, NOW), "hour");
});

test("age windows NEST, except `older`, which is its own bin", () => {
  const tenMin = NOW - 10 * 60_000;
  for (const a of ["hour", "day", "week"]) assert.equal(withinAge(tenMin, a, NOW), true, a);
  assert.equal(withinAge(tenMin, "older", NOW), false);

  const lastMonth = NOW - 40 * 24 * H;
  for (const a of ["hour", "day", "week"]) assert.equal(withinAge(lastMonth, a, NOW), false, a);
  assert.equal(withinAge(lastMonth, "older", NOW), true);
});

test("a chip's number is the length of the list its tap opens — cross-filtered", () => {
  const items = [
    item({ id: "a", status: "failed", createdAt: NOW - 10 * 60_000 }),   // failed, past hour
    item({ id: "b", status: "failed", createdAt: NOW - 5 * 24 * H }),    // failed, past week
    item({ id: "c", status: "done", createdAt: NOW - 10 * 60_000 }),     // done, past hour
    item({ id: "d", status: "queued", createdAt: NOW - 30 * 24 * H }),   // queued, older
  ];

  // Nothing on: the counts describe the whole list.
  const open = backlogCounts(items, { status: null, age: null }, NOW);
  assert.equal(open.status.failed, 2);
  assert.equal(open.age.hour, 2);
  assert.equal(open.age.week, 3);
  assert.equal(open.age.older, 1);

  // With "past hour" on, the STATUS chips must count only what is in that hour —
  // tapping "failed 1" there opens one row, and the old bug was a chip saying 2.
  const inHour = backlogCounts(items, { status: null, age: "hour" }, NOW);
  assert.equal(inHour.status.failed, 1);
  assert.equal(inHour.status.done, 1);
  assert.equal(inHour.status.queued, 0);

  // …and symmetrically: with "failed" on, the AGE chips count only failures.
  const failed = backlogCounts(items, { status: "failed", age: null }, NOW);
  assert.equal(failed.age.hour, 1);
  assert.equal(failed.age.week, 2);
  assert.equal(failed.age.older, 0);

  // The number and the cut agree, which is the whole invariant.
  const cut = items.filter((it) => matchesBacklogFilter(it, { status: "failed", age: "week" }, NOW));
  assert.equal(cut.length, failed.age.week);
});

test("the two dimensions combine, and an empty filter matches everything", () => {
  const it = item({ status: "done", createdAt: NOW - 2 * H });
  assert.equal(matchesBacklogFilter(it, { status: null, age: null }, NOW), true);
  assert.equal(matchesBacklogFilter(it, { status: "done", age: "day" }, NOW), true);
  assert.equal(matchesBacklogFilter(it, { status: "done", age: "hour" }, NOW), false);
  assert.equal(matchesBacklogFilter(it, { status: "failed", age: "day" }, NOW), false);
  assert.equal(hasBacklogFilter({ status: null, age: null }), false);
  assert.equal(hasBacklogFilter({ status: null, age: "older" }), true);
});

test("the bar says what it is showing, in both dimensions", () => {
  assert.match(backlogFilterSentence({ status: "failed", age: null }), /failed/);
  assert.match(backlogFilterSentence({ status: null, age: "day" }), /past 24h/);
  assert.match(backlogFilterSentence({ status: "queued", age: "older" }), /queued.*over a week ago/);
});

test("an auto-generated label is not a label", () => {
  const text = "For this and all other things that need doing, please check the inbox first";
  // What `Backlog`'s add() writes: the first 40 characters of the text.
  assert.equal(realLabel({ text, label: text.slice(0, 40) }), null);
  assert.equal(realLabel({ text, label: "" }), null);
  assert.equal(realLabel({ text, label: "inbox triage" }), "inbox triage");
});

test("a span reads as a duration, never as a negative one", () => {
  assert.equal(fmtSpan(0), "0s");
  assert.equal(fmtSpan(-5000), "0s");
  assert.equal(fmtSpan(45_000), "45s");
  assert.equal(fmtSpan(90_000), "1m 30s");
  assert.equal(fmtSpan(3 * H + 4 * 60_000), "3h 4m");
  assert.equal(fmtSpan(50 * H), "2d 2h");
});

// ── `ids`: the cut a count opens ─────────────────────────────────────────────

const cut = (items, f) => items.filter((it) => matchesBacklogFilter(it, f, NOW));

test("the empty filter is empty in all FIVE dimensions", () => {
  // The fourth is the KIND, and `null` is not `"none"`: the first shows every
  // row, the second shows exactly the rows nobody has said a kind for. A
  // default that collapsed the two would make the sheet open on a cut nobody
  // asked for. The fifth is the CLOCK, and it is the one axis with a single
  // interesting side — `null` is "no filter", never "the rows with no clock".
  assert.deepEqual(NO_BACKLOG_FILTER, { status: null, age: null, category: null, ids: null, clock: null });
  assert.equal(hasBacklogFilter({ ...NO_BACKLOG_FILTER, clock: true }), true);
  assert.equal(hasBacklogFilter(NO_BACKLOG_FILTER), false);
  assert.equal(backlogFilterSentence(NO_BACKLOG_FILTER), "showing everything");
});

test("an ids cut is a filter, and an EMPTY one shows nothing rather than everything", () => {
  assert.equal(hasBacklogFilter({ ...NO_BACKLOG_FILTER, ids: ["a"] }), true);
  // The other reading — "empty means no filter" — makes a cut meant to show two
  // specific rows silently show the whole repo the moment the ids go missing,
  // which is a count that has stopped describing its own tap. `null` is how you
  // say "no ids filter".
  assert.equal(hasBacklogFilter({ ...NO_BACKLOG_FILTER, ids: [] }), true);
  assert.deepEqual(cut([item({ id: "a" })], { ...NO_BACKLOG_FILTER, ids: [] }), []);
});

test("“merged from 3” opens exactly those three", () => {
  const items = ["a", "b", "c", "d", "e"].map((id) => item({ id }));
  assert.deepEqual(
    cut(items, { ...NO_BACKLOG_FILTER, ids: ["a", "c", "e"] }).map((it) => it.id),
    ["a", "c", "e"],
  );
});

test("an ids cut shows an ARCHIVED row — the base it is handed is the unhidden one", () => {
  // Every original of a merge is archived. A predicate that also knew about the
  // sheet's archived toggle would make "merged from 3" open one row; the hide
  // is the caller's job, membership is all this asks.
  const items = [item({ id: "a", archived: true }), item({ id: "b" }), item({ id: "c", archived: true })];
  assert.deepEqual(cut(items, { ...NO_BACKLOG_FILTER, ids: ["a", "c"] }).map((it) => it.id), ["a", "c"]);
});

test("with an ids cut on, the status and age chips count INSIDE it", () => {
  const items = [
    item({ id: "a", status: "failed" }),
    item({ id: "b", status: "failed" }),
    item({ id: "c", status: "done" }),
    item({ id: "d", status: "failed" }),          // outside the ids cut
  ];
  const f = { ...NO_BACKLOG_FILTER, ids: ["a", "b", "c"] };
  const counts = backlogCounts(items, f, NOW);
  assert.equal(counts.status.failed, 2, "d is not in the cut, so it is not in the count");
  assert.equal(cut(items, { ...f, status: "failed" }).length, counts.status.failed);
});

test("every chip's number is the length of its own cut, in every combination of the three", () => {
  const items = [
    item({ id: "a", status: "failed", createdAt: NOW - 10 * 60_000 }),
    item({ id: "b", status: "queued", createdAt: NOW - 5 * H }),
    item({ id: "c", status: "failed", createdAt: NOW - 3 * 24 * H }),
    item({ id: "d", status: "done", createdAt: NOW - 30 * 24 * H }),
    item({ id: "e", status: "failed", createdAt: NOW - 2 * H }),
  ];
  for (const ids of [null, ["a", "b", "c"], ["a", "e"]]) {
    for (const status of [null, ...BACKLOG_STATUSES]) {
      for (const age of [null, ...BACKLOG_AGES]) {
        const f = { status, age, ids };
        const counts = backlogCounts(items, f, NOW);
        for (const st of BACKLOG_STATUSES) {
          assert.equal(counts.status[st], cut(items, { ...f, status: st }).length, `status ${st} with ${JSON.stringify(f)}`);
        }
        for (const a of BACKLOG_AGES) {
          assert.equal(counts.age[a], cut(items, { ...f, age: a }).length, `age ${a} with ${JSON.stringify(f)}`);
        }
      }
    }
  }
});

test("an ids cut NAMES ITSELF, and the other dimensions ride behind it", () => {
  const ids = ["a", "b", "c"];
  assert.equal(backlogFilterSentence({ status: null, age: null, ids }), "made from these");
  assert.equal(
    backlogFilterSentence({ status: null, age: null, ids }, "merged into “fix the flaky test”"),
    "merged into “fix the flaky test”",
  );
  assert.equal(
    backlogFilterSentence({ status: "failed", age: "day", ids }, "merged into “x”"),
    "merged into “x” · failed · added in the past 24h",
  );
  assert.equal(backlogFilterSentence({ status: null, age: null, ids }, "   "), "made from these",
    "a blank label is no label");
});

/**
 * The "n of N" under the bar must describe a list the reader can actually see.
 *
 * An ids cut counts against a base that INCLUDES archived rows, and it has to:
 * every original of a merge is archived, so counting it against the default
 * view would count it against a list holding none of them. The default view
 * underneath does hide them, so "3 of 12" over a list drawing nine was a true
 * number about something nobody had on screen.
 */
test("an ids cut says which base its N is counted against", () => {
  const ids = ["a", "b", "c"];
  assert.equal(backlogCountWords(3, 12, { status: null, age: null, ids }), "3 of 12, archived included");
  // Every other cut runs over the base the reader is looking at, so it says
  // nothing extra — a clause on every filter bar is noise on all but one.
  assert.equal(backlogCountWords(3, 9, { status: "failed", age: null, ids: null }), "3 of 9");
  assert.equal(backlogCountWords(0, 9, NO_BACKLOG_FILTER), "0 of 9");
});

/**
 * ── The undo, reachable in the case it exists for ────────────────────────────
 *
 * The pass picks and applies in the same breath and the merged row is routinely
 * the pick, so the pre-run window is about one tick. Whoever the notification
 * wakes meets a row that has ALREADY RUN — which is exactly the person the
 * safety catch was built for, and exactly the person who used to be told to
 * bring N rows back by hand with the machine's text unreversed.
 */
test("a merged row offers a verb in every state the host accepts one in", () => {
  const q = { mergedFrom: 3, status: "queued", online: true };
  assert.equal(undoOfferFor(q), "undo");
  assert.equal(undoOfferFor({ ...q, status: "done" }), "again");
  assert.equal(undoOfferFor({ ...q, status: "failed" }), "again",
    "a merge that failed is exactly when you want the originals back");
  /*
   * RUNNING is a verb too, and this line is the fix for a wrong one.
   *
   * The sheet used to answer `null` here and draw a refusal instead — *"can be
   * put back once it has finished"*. The host accepts the message in this state
   * (`smartpick.ts`'s `undo`: it archives the row WITHOUT stopping it, restores
   * the members and answers "still running and has not been stopped"), so the
   * phone was withholding a capability, and wording a refusal nobody would
   * make, in the one state the sleeper wakes into. On a phone "come back later"
   * is the words staying archived for ever.
   */
  assert.equal(undoOfferFor({ ...q, status: "running" }), "again");
  // …and the row's own note is what stops `again` over-claiming: the tap does
  // not stop the session that is typing those words.
  assert.match(undoWhileRunningWords(3), /it is running now and will not be stopped/);
  assert.match(undoWhileRunningWords(3), /queues your 3 originals again, as they were/);
  assert.match(undoWhileRunningWords(1), /queues your original again/);
  // The retired refusal, in both of its claims.
  assert.doesNotMatch(undoWhileRunningWords(3), /once it has finished/);
  assert.doesNotMatch(undoWhileRunningWords(3), /stay under archived/);
  // Offline every mutation is read-only and no verb is drawn, so the row must
  // not promise one — the sheet's own offline line covers it.
  assert.equal(undoOfferFor({ ...q, online: false }), null);
  // A row nothing was merged into has no verb and no sentence.
  assert.equal(undoOfferFor({ mergedFrom: 0, status: "queued", online: true }), null);
});

/**
 * ── …and the row it archives may not disappear while it runs ────────────────
 *
 * The tap above ARCHIVES a running row (the host does, on purpose: the row
 * that ran is the only account of the session running it). Three places cut on
 * `archived` — the sheet's default base, the repo counts, the composer's badge
 * — so without this predicate the one row that is doing something vanished
 * from all three mid-run, and the badge dropped by one for a session still
 * typing.
 */
test("the archived cut never hides a running row", () => {
  assert.equal(hiddenByArchive({ archived: true, status: "done" }), true);
  assert.equal(hiddenByArchive({ archived: true, status: "queued" }), true);
  assert.equal(hiddenByArchive({ archived: true, status: "running" }), false,
    "unmerge archives a running row; hiding it is how a row stops saying what happened to it");
  assert.equal(hiddenByArchive({ archived: false, status: "done" }), false);
  assert.equal(hiddenByArchive({ status: "queued" }), false, "absent means not archived");
});

test("the row's sentence is a different promise on each side of having run", () => {
  assert.equal(smartWroteWords(2, "undo"), "written by the smart pick, from your 2 — undo puts them back");
  const ran = smartWroteWords(2, "again");
  assert.match(ran, /it has already run/);
  assert.match(ran, /put them back queues your 2 originals as they were/);
  // It must NOT read as an undo once it has run: the machine's words have been
  // typed into a session and cannot be untyped.
  assert.doesNotMatch(ran, /undo/);
  assert.match(smartWroteWords(1, "again"), /queues your original as they were/);
  // Offline: what wrote the row, and nothing about a button that is not drawn.
  assert.equal(smartWroteWords(2, null), "written by the smart pick, from your 2");
  // And the retired sentence, which sent a sleeping person to do it by hand.
  assert.doesNotMatch(smartWroteWords(2, "again"), /by hand/);
  assert.doesNotMatch(undoWhileRunningWords(2), /by hand/);
});

test("“as they were” says what that means when an original had a CLOCK", () => {
  // `undo` restores each original with the `nextAt` it had. Merged twins on
  // *tonight 21:00*, put back tomorrow, come back to a ladder that fails them
  // with "that instant has passed and this was a one-off — post it again". So
  // the receipt was promising a run that cannot happen — under the one button
  // the whole case for applying a merge automatically rests on.
  const ran = smartWroteWords(2, "again", true);
  assert.match(ran, /put them back queues your 2 originals as they were/, "the promise it CAN keep is unchanged");
  assert.match(ran, /clocks come back with them/);
  assert.match(ran, /failed rows wearing “drop the clock”/, "and the row is not lost — that verb puts it back in the queue");
  // Not a COUNT of which ones will fail: that depends on a tick, a grace and,
  // for a window rule, a usage reading this phone has not got. A heuristic here
  // degrades to a true sentence about all of them, never to a number about
  // some. `\d` would catch "1 of the 2" creeping back in.
  assert.doesNotMatch(ran.slice(ran.indexOf("clocks come back")), /\d/);
  assert.match(undoWhileRunningWords(2, true), /clocks come back with them/);
  assert.match(smartWroteWords(2, "undo", true), /undo puts them back — their clocks come back with them/);
  // Untimed originals are the case the old sentence was written for, and it is
  // still exactly right for them: nothing extra is said.
  assert.equal(smartWroteWords(2, "again", false), smartWroteWords(2, "again"));
  assert.doesNotMatch(smartWroteWords(2, "again"), /clock/);
  assert.doesNotMatch(undoWhileRunningWords(2), /clock/);
});

/**
 * ── The seam between the two sheets ──────────────────────────────────────────
 *
 * "I still see 2 very confusing different views with no cross linking." A
 * schedule exists to write backlog rows and a backlog row often came from one,
 * and neither list named the other. These three sentences are that link, and
 * the reason they are pinned together is the reason they are in one module: the
 * words on the CHIP and the words in the filter bar the chip OPENS are one
 * claim about one rule, and a second copy of either is how a tap starts
 * describing a different thing from the one it promised.
 */
test("the schedule seam names the same rule on both sides of every tap", () => {
  // Item → rule: the chip on a backlog row, and what Schedules then says.
  assert.equal(fromScheduleWords("weekly sweep"), "from the schedule \u201cweekly sweep\u201d");
  assert.equal(scheduleRuleLabel("weekly sweep"), "the schedule \u201cweekly sweep\u201d");
  // Rule → items: the Backlog's filter bar when a card's "1 item" opened it.
  assert.equal(scheduleItemsLabel("weekly sweep"), "written by the schedule \u201cweekly sweep\u201d");
  // Each one NAMES the rule rather than describing a cut — the `idsLabel` rule:
  // "showing 1 item" would make the reader work out which schedule it meant.
  for (const w of [fromScheduleWords("x"), scheduleRuleLabel("x"), scheduleItemsLabel("x")]) {
    assert.match(w, /schedule/, "the seam has to say which list it crossed from");
    assert.match(w, /\u201cx\u201d/, "…and which rule");
  }
});

/**
 * ── A backlog row that carries a CLOCK ───────────────────────────────────────
 *
 * Recurrence, not trigger kind, decides which list a row lives in: a one-off
 * aimed at one place is waiting work whose WHEN happens to be an instant, and
 * it is a row here rather than a card in Schedules. These are the sentences it
 * then says about itself, and every one of them is pinned because in this repo
 * the strings are the deliverable.
 */
const clock = (o = {}) => ({ rule: { kind: "once", at: NOW + 2 * H }, graceMin: 120, nextAt: NOW + 2 * H, ...o });

test("a clock says the RULE's own words, plus what is true of this occurrence", () => {
  // `describeRule` is `@waterplane/shared`'s and is never re-worded here — the send
  // sheet, the schedule card, the Schedules directory line and this chip are
  // one rule said one way. What the chip adds is the ARMED INSTANT, relative,
  // because every other time on a backlog row is relative too.
  const w = clockWords(clock(), NOW, "queued");
  assert.equal(w, `${describeRule({ kind: "once", at: NOW + 2 * H })} · next in 2h`);
  // The `now` is the CALLER's, so a chip and the row under it cannot read two
  // different clocks one millisecond apart.
  assert.match(clockWords(clock({ nextAt: NOW + 30 * 60_000 }), NOW, "queued"), /next in 30m/);
  // An instant already behind us is due now, never a negative countdown.
  assert.match(clockWords(clock({ nextAt: NOW - 60_000 }), NOW, "queued"), /due now/);
});

test("nothing armed is not the same fact twice — a window rule is WAITING, a spent one just says its rule", () => {
  const win = { kind: "window", window: "weekly", edge: "after" };
  // The ordinary first state of a rule anchored to a usage window: the host
  // arms it on its first scrape. Not "not armed", which names a switch.
  assert.match(clockWords({ rule: win, graceMin: 120, nextAt: null }, NOW, "queued"),
    /waiting for a usage reading/);
  // …and only while it is still queued. On a row that has been and gone it
  // would describe a future that is not coming.
  assert.doesNotMatch(clockWords({ rule: win, graceMin: 120, nextAt: null }, NOW, "failed"),
    /waiting for a usage reading/);
  // A spent `once` says its rule and nothing else — the row's own `failed`
  // verdict is what says what happened, and a second sentence invented here
  // would be this file guessing.
  const spent = clockWords(clock({ nextAt: null, rule: { kind: "once", at: NOW - H } }), NOW, "failed");
  assert.equal(spent, describeRule({ kind: "once", at: NOW - H }));
  assert.doesNotMatch(spent, /next|waiting/);
});

test("`wait until free` keeps its own chip, and dropping the clock does not drop it", () => {
  // The host-wide half of the schedule vocabulary's *wait until free*. Worth a
  // chip because it is the one wait the list cannot show: `serial` is "one at a
  // time in this repo", which the order on screen already says.
  assert.equal(HOLD_FOR_HOST_TEXT, "holds until the desktop is free");
  assert.match(HOLD_FOR_HOST_TITLE, /not just in this repo/);
  // The promise the row makes about the OTHER button, said where a person can
  // read it before they tap: `holdForHost` survives `drop the clock`.
  assert.match(HOLD_FOR_HOST_TITLE, /dropping the clock does not drop it/);
  // …and said VISIBLY, because a `title` is invisible on a phone and a phone is
  // the only device this app is used from. The clause is drawn exactly where
  // the question can arise — a row with a clock, in a state that offers to drop
  // it — and nowhere else, so an ordinary held row still reads as one chip.
  assert.equal(holdChipWords(false), HOLD_FOR_HOST_TEXT);
  assert.equal(holdChipWords(true), "holds until the desktop is free · survives a dropped clock");
});

test("what dropping a clock DOES is text on the row, not a title nobody can see", () => {
  // The clause that lived only in a `title`: what happens after the tap. It is
  // the whole answer to "how do I run the seven that were skipped", and on the
  // one device this app runs on it was not said at all.
  const failed = dropClockNote("failed");
  assert.match(failed, /auto and the smart pick take it from there/);
  assert.match(failed, /a one-off cannot be re-armed/);
  const queued = dropClockNote("queued");
  assert.match(queued, /in turn instead of at its time/);
  assert.doesNotMatch(queued, /passed|re-armed/, "nothing is being rescued on a queued row");
  // Still two different offers, and still neither of them promises a start:
  // auto, serial and the repo's own order decide that.
  for (const w of [failed, queued]) assert.doesNotMatch(w, /runs now|immediately/);
  assert.notEqual(failed, queued);
});

test("`drop the clock` is two different offers and never one sentence", () => {
  // failed: a rescue. This is the tap that answers "run the seven that were
  // skipped" — the instant went by, a one-off cannot be re-armed, and the row
  // is otherwise stuck saying it missed something for ever.
  const failed = dropClockTitle("failed");
  assert.match(failed, /its instant has passed/);
  assert.match(failed, /waits its turn like any other item/);
  assert.match(failed, /smart pick/, "the whole reason this verb exists is that the pass only sees backlog rows");
  // queued: not a rescue. Nothing is being saved, and the sentence must not
  // read as though something is.
  const queued = dropClockTitle("queued");
  assert.match(queued, /in turn instead of at its time/);
  assert.doesNotMatch(queued, /passed/);
  // Neither promises a start: auto, serial and the repo's order decide that.
  for (const w of [failed, queued]) assert.doesNotMatch(w, /runs now|immediately/);
  // And the receipt is about the CLOCK, not about a state — the host kicks
  // synchronously, so the row may be blocked behind the ladder or already
  // firing by the time this is read.
  assert.equal(DROP_CLOCK_TOAST, "clock dropped — it waits its turn like any other item");
  assert.doesNotMatch(DROP_CLOCK_TOAST, /queued/);
});

test("the bulk verb's number is the timed rows in the CUT, and it says what it left alone", () => {
  // A count on a control is a filter: "these 7" acts on exactly seven.
  assert.equal(dropClocksLabel(7), "drop the clocks on these 7");
  assert.equal(dropClocksLabel(1), "drop the clocks on this one");
  // Where the cut also holds rows with no clock, the note says so rather than
  // letting "these 5" float over a list of seven.
  assert.match(dropClocksNote(5, 7), /^5 rows of the 7 shown carry a clock — the rest have none and are left alone\./);
  assert.match(dropClocksNote(1, 3), /^one row of the 3 shown carries a clock/);
  // With no rest there is no clause about one: "7 rows of the 7 shown carry a
  // clock — the rest have none" sends a reader looking for rows that are not
  // there. The count stays, because it says the button acts on the whole cut.
  assert.match(dropClocksNote(7, 7), /^every one of the 7 rows here carries a clock\./);
  assert.doesNotMatch(dropClocksNote(7, 7), /the rest/);
  // **The two sentences that used to live only in `title` attributes**, which
  // on a phone is nowhere. Both are things a person needs BEFORE the tap: what
  // becomes of the words, and what the tap does not take away.
  for (const n of [dropClocksNote(5, 7), dropClocksNote(7, 7)]) {
    assert.match(n, /auto and the smart pick take it from there/);
    assert.match(n, /hold until the desktop is free keep doing so/);
  }
  // ONE tap, ONE receipt. The bar sends seven frames — the wire has no batch
  // `intent.update` — and said the same sentence seven times, which put one
  // decision into the toast log seven times and the count into it never.
  assert.equal(dropClocksToast(7), "clocks dropped on 7 — they wait their turn like any other item");
  assert.equal(dropClocksToast(1), DROP_CLOCK_TOAST, "one row gets the row's own receipt, not a plural about one");
});

test("archiving a whole cut says the cut's number, and that archiving is not deleting", () => {
  // The same rule as its drop-clocks twin: a count on a control is a filter, so
  // "these 5" archives exactly the five on screen and none of the repo's other
  // fifty-seven rows.
  assert.equal(archiveDoneLabel(5), "archive these 5");
  assert.equal(archiveDoneLabel(1), "archive this one");
  // Drawn over the `done` cut, every row qualifies — so the ordinary sentence
  // is the no-remainder one, and it must not invite a reader to look for rows
  // that are not there.
  assert.match(archiveDoneNote(5, 5), /^every one of the 5 rows here is finished\./);
  assert.doesNotMatch(archiveDoneNote(5, 5), /the rest/);
  // With `show archived` on the cut also holds rows already archived, and those
  // are a real remainder the tap leaves alone.
  assert.match(archiveDoneNote(3, 8), /^3 rows of the 8 shown are finished and not yet archived — the rest are already archived and are left alone\./);
  assert.match(archiveDoneNote(1, 4), /^one row of the 4 shown is finished/);
  // **The sentence somebody needs BEFORE the tap.** "Archive" reads as "throw
  // away" to a reader who has not been told otherwise, and a bulk button is the
  // worst place to find out you were wrong either way round.
  for (const n of [archiveDoneNote(5, 5), archiveDoneNote(3, 8)]) {
    assert.match(n, /Archiving is not deleting/);
    assert.match(n, /the words stay/);
    assert.match(n, /brought back from its own row/);
  }
  // ONE tap, ONE receipt — the wire has no batch `backlog.archive`, so the
  // sentence is the only place the count survives.
  assert.match(archiveDoneToast(20), /^20 archived/);
  assert.doesNotMatch(archiveDoneToast(1), /^1 archived/, "one row is not a plural about one");
  // Neither receipt may read as a delete.
  for (const t of [archiveDoneToast(1), archiveDoneToast(20)]) {
    assert.match(t, /words stay/);
    assert.doesNotMatch(t, /delet|remov|gone/);
  }
});

test("the assess button counts what a run could actually judge, not the cut", () => {
  // `assess.run` carries the cut now, so this button follows the list like
  // every other count on the screen. The number is the ASSESSABLE rows —
  // finished and running rows go in as context and can never carry a verdict,
  // so counting them would put a number on the button that the run does not
  // honour.
  const cut = [
    { id: "a", status: "queued" },
    { id: "b", status: "failed" },
    { id: "c", status: "done" },
    { id: "d", status: "running" },
    { id: "e", status: "queued", archived: true },
  ];
  assert.deepEqual(assessableInCut(cut), ["a", "b"]);
  assert.equal(assessScopeLabel(2), "assess these 2");
  assert.equal(assessScopeLabel(1), "assess this one");
  // The note carries both numbers, and `dropClocksNote`'s rule decides the
  // shape: never describe a remainder that is not there.
  assert.match(assessScopeNote(2, 5), /^2 rows of the 5 shown are still open — the rest are finished or running and cannot be judged\./);
  assert.match(assessScopeNote(1, 4), /^one row of the 4 shown is still open/);
  assert.match(assessScopeNote(5, 5), /^every one of the 5 rows here is still open\./);
  assert.doesNotMatch(assessScopeNote(5, 5), /the rest/);
  // **What scoping does NOT do.** Without this clause the sentence invites the
  // opposite reading — that a scoped run looks at less of the repo — when the
  // narrowing is only of which rows may carry a verdict. The evidence is the
  // repo either way, and that is what makes the scoped answer worth having.
  for (const n of [assessScopeNote(2, 5), assessScopeNote(5, 5)]) {
    assert.match(n, /still reads the whole repo as evidence/);
    assert.match(n, /which rows it may return a verdict on/);
  }
  // A cut with nothing open in it removes the button and says why — the
  // `Unavailable.tsx` rule, never a dimmed control whose reason is in a title.
  assert.deepEqual(assessableInCut([{ id: "c", status: "done" }]), []);
  assert.match(ASSESS_NONE_IN_CUT, /nothing in this cut is still open/);
  assert.match(ASSESS_NONE_IN_CUT, /waiting or failed/);
});

test("a legacy parent keeps its chip, and the chip's tap names where that row now lives", () => {
  // The seam's three labels, and the third is the one the change broke: a
  // one-off that fired and wrote a child BEFORE recurrence decided the list is
  // not a `ScheduleEntry` any more, so `scheduleRuleLabel` would send the
  // reader to a sheet that cannot hold it. Eight such rows on this desktop.
  const parent = scheduleParentLabel("tidy the exports");
  assert.match(parent, /the timed one-off “tidy the exports”/);
  // It says WHY the row is set aside rather than leaving an archived row
  // looking like something that was thrown away.
  assert.match(parent, /set aside/);
  assert.match(parent, /this row is the account of it/);
  // Three different claims, three different sentences — a cut that opens a
  // backlog row must not word itself as one that opens a rule.
  assert.notEqual(parent, scheduleRuleLabel("tidy the exports"));
  assert.notEqual(parent, scheduleItemsLabel("tidy the exports"));
  assert.doesNotMatch(parent, /^the schedule/);
});

test("the Schedules directory names the repo on both sides of its tap", () => {
  // The directory line's cut, and the foot's cut. Both NAME the thing (the
  // `idsLabel` rule) rather than describing a count, and both say the two words
  // that tell the reader which list they crossed from.
  assert.equal(onClockLabel("myapp"), "on a clock in myapp");
  assert.equal(goneOnClockLabel("myapp"), "been and gone on a clock in myapp");
  for (const w of [onClockLabel("x"), goneOnClockLabel("x")]) {
    assert.match(w, /clock/, "the seam has to say what kind of row it crossed to");
    assert.match(w, /\bx\b/, "…and which repo");
  }
  // "been and gone" and never "already ran": the clock is all `isSpentOnce`
  // reads, so a one-off the desktop slept through never fired at all.
  assert.doesNotMatch(goneOnClockLabel("x"), /ran|run/);
});

// ── `run it again` — the verb for the row with no clock ─────────────────────
//
// `drop the clock`'s sibling and held to every one of its rules: the claim on
// the row and the claim in the `title` are ONE string (a title is invisible on
// a phone), the count on the control is the cut on screen, the note says what
// it leaves alone, and one tap is one receipt. What it adds is the state it
// rescues — a failed row is terminal, so nothing was ever going to look at it
// again, which on the repo this was written in was 19 rows out of 19.

const LIVE = new Set(["s-live"]);

test("the verb's promise is ONE string, and it says all four things a tap needs", () => {
  assert.equal(RUN_AGAIN_LABEL, "run it again");
  const note = runAgainRowNote({});
  // Where the row goes — the QUEUE, which is the whole difference from the
  // button beside it.
  assert.match(note, /put it back in the queue/);
  // What runs it afterwards, which is the answer to "how do I get the failed
  // ones moving" and which lived nowhere at all before.
  assert.match(note, /a new session of its own when its turn comes/);
  assert.match(note, /auto and the smart pick take it from there/);
  // What is NOT wiped.
  assert.match(note, /The failure it had stays on the row/);
  // …and what the other button does instead, because they sit side by side.
  assert.match(note, /“re-fire” beside it runs it this second instead/);
});

test("a row aimed at a session is NOT promised a session of its own", () => {
  // The verb said "it runs again in a new session of its own" on every failed
  // row, the sheet's *In <session>* group included — and those run in THAT
  // conversation and nowhere else. The sentence reads the row now, off the same
  // field the group heads read (`targetSessionId`, never the optional `fresh`).
  const aimed = runAgainRowNote({ targetSessionId: "s-live" });
  assert.match(aimed, /in the session it is aimed at, as soon as that session is free/);
  assert.match(aimed, /It does not open a session of its own/);
  assert.doesNotMatch(aimed, /a new session of its own/);
  // The clauses that are true of both rows survive on both.
  assert.match(aimed, /put it back in the queue/);
  assert.match(aimed, /The failure it had stays on the row/);
  assert.match(aimed, /“re-fire” beside it runs it this second instead/);
});

test("a failed row aimed at a session that CLOSED gets a sentence, not a button", () => {
  // Nothing re-aims such a row, so a re-queue turns a stopped row into one that
  // waits for ever — which looks like progress and is not. The verb is not
  // drawn at all; this is drawn instead, and it names the way out
  // (`Unavailable.tsx`: a refusal is words, never a dimmed control).
  const held = runAgainClosedNote();
  assert.match(held, /aimed at a session that has closed/);
  assert.match(held, /nothing re-aims it/);
  assert.match(held, /wait for ever/);
  assert.match(held, /Edit it to pick another session, or take the aim off/);
  assert.match(held, /“run it again” comes back/);
  // Never offered as the way out: a hand fire resolves the same dead id.
  assert.doesNotMatch(held, /re-fire/);
});

test("the receipt is about the QUEUE, never about a state the host has not reached", () => {
  assert.equal(RUN_AGAIN_TOAST, "put back in the queue — it runs again when its turn comes");
  assert.doesNotMatch(RUN_AGAIN_TOAST, /running|started/,
    "the row goes back BEHIND the ladder — it may be waiting on auto, on the repo or on the desktop");
  // One tap, one receipt: the wire has no batch frame, so the SENTENCE is the
  // only place the count survives.
  // …and it names no session either: where the words land is the row's own
  // fact, said on the row, and a receipt that guessed would make the same
  // unkeepable promise one surface along.
  assert.doesNotMatch(RUN_AGAIN_TOAST, /session/);
  assert.equal(runAgainToast(1), RUN_AGAIN_TOAST);
  assert.match(runAgainToast(7), /^7 put back in the queue/);
  assert.match(runAgainToast(7), /as their turns come/);
  // Rows aimed at DIFFERENT live sessions run in parallel, so "one at a time"
  // was a scheduling promise a mixed cut contradicts.
  assert.doesNotMatch(runAgainToast(7), /one at a time/);
});

test("the cut is the failures with no clock, nothing set aside, and no dead target", () => {
  const rows = [
    item({ id: "a", status: "failed" }),
    item({ id: "b", status: "failed", at: { rule: { kind: "once", at: NOW }, graceMin: 30, nextAt: null } }),
    item({ id: "c", status: "failed", archived: true }),
    item({ id: "d", status: "queued" }),
    item({ id: "e", status: "done" }),
    item({ id: "f", status: "failed" }),
    item({ id: "g", status: "failed", targetSessionId: "s-live" }),
    item({ id: "h", status: "failed", targetSessionId: "s-gone" }),
  ];
  assert.deepEqual(runAgainIds(rows, LIVE), ["a", "f", "g"]);
  // A clocked row's verb is `drop the clock` — a different sentence about a
  // different reason, and offering both on one row would be two buttons for one
  // tap with no way to tell which.
  assert.equal(runAgainIds([rows[1]], LIVE).length, 0);
  // A row somebody set aside stays set aside; its own unarchive is the tap.
  assert.equal(runAgainIds([rows[2]], LIVE).length, 0);
  // A row whose session has gone is HELD, and that is a third answer rather
  // than a silent no — the row has a sentence to draw.
  assert.equal(runAgainState(rows[7], LIVE), "held-closed");
  assert.equal(runAgainState(rows[6], LIVE), "offered");
  assert.equal(runAgainState(rows[3], LIVE), "none");
});

test("the row's button and the bar's count ask ONE function, not two copies of the edge", () => {
  // `Backlog.tsx` restated `failed && !at && !archived` beside a comment
  // claiming it was not a second copy. It was — and a second copy is how the
  // bar says 19 over a list where 20 rows wear the verb.
  const rows = [
    item({ id: "a", status: "failed" }),
    item({ id: "b", status: "failed", targetSessionId: "s-gone" }),
    item({ id: "c", status: "done" }),
  ];
  assert.deepEqual(runAgainIds(rows, LIVE), rows.filter((r) => runAgainEligible(r, LIVE)).map((r) => r.id));
  assert.equal(runAgainEligible(rows[1], LIVE), false);
});

test("the count on the control is the cut, and the note says what it leaves alone", () => {
  assert.equal(runAgainLabel(1), "run this one again");
  assert.equal(runAgainLabel(7), "run these 7 again");
  // n === shown: there is no rest, and a clause about an empty remainder invites
  // a reader to look for rows that are not there — `dropClocksNote`'s rule.
  const all = runAgainNote(7, 7);
  assert.match(all, /every one of the 7 rows here can go back in the queue/);
  assert.doesNotMatch(all, /the rest/);
  // n < shown: say what is left alone, and why, so the number can be checked
  // against the list.
  const some = runAgainNote(5, 7);
  assert.match(some, /5 rows of the 7 shown/);
  assert.match(some, /the rest carry a clock/);
  assert.match(some, /drop the clock/);
  // A dead target is a THIRD reason a row is left out, so it is named beside
  // the clock and the archive rather than folded into "the rest".
  assert.match(some, /aimed at a session that closed/);
  assert.match(some, /set aside/);
  assert.match(runAgainNote(1, 7), /one row of the 7 shown/);
  // Both wordings carry what becomes of the words — the serialization and where
  // each one lands are the two facts that make a nineteen-row tap safe. This is
  // the ALL-FRESH cut, which is the only one that may say either.
  for (const s of [all, some]) {
    assert.match(s, /one at a time in this repo/);
    assert.match(s, /each in a session of its own/);
    assert.match(s, /auto and the smart pick take it from there/);
    assert.match(s, /the failure each one had stays on its row/);
  }
});

test("the bulk note says where the words land, counted rather than guessed", () => {
  // All aimed: "a session of its own" is the one thing that will NOT happen,
  // and "one at a time in this repo" is wrong too — rows aimed at different
  // sessions run in parallel, so the cut decides the clause, never a default.
  const aimed = runAgainNote(3, 3, 3);
  assert.match(aimed, /They run again in the sessions they are aimed at, as those come free/);
  assert.doesNotMatch(aimed, /a session of its own/);
  assert.doesNotMatch(aimed, /one at a time/);
  // Mixed: both halves, each with its own count, so the sentence can be checked
  // against the rows on screen.
  const mixed = runAgainNote(5, 7, 2);
  assert.match(mixed, /3 run again in a session of its own, one at a time in this repo/);
  assert.match(mixed, /2 in the sessions they name, as those come free/);
  for (const s of [aimed, mixed]) assert.match(s, /the failure each one had stays on its row/);
  // The default is "none aimed", which is the all-fresh repo this was written
  // on and the sentence the bar has always said there.
  assert.equal(runAgainNote(5, 7), runAgainNote(5, 7, 0));
  // …and the count is taken over the ELIGIBLE rows, so a row whose session has
  // gone is not counted as aimed by a bar that is not acting on it.
  assert.equal(runAgainAimedCount([
    item({ id: "a", status: "failed" }),
    item({ id: "b", status: "failed", targetSessionId: "s-live" }),
    item({ id: "c", status: "failed", targetSessionId: "s-gone" }),
  ], LIVE), 1);
});

// ── …and what the row says once it has been put back ────────────────────────

const requeue = (o = {}) => ({ at: NOW - 4 * 60_000, by: "assess", n: 1, ...o });

test("a revived row says who put it back and how long ago", () => {
  // The age is spelled the way every other age on this row is — `4m ago`, not
  // `fmtSpan`'s `4m 0s`, which is a DURATION and belongs beside "took".
  assert.equal(requeuedWords(requeue(), "queued", NOW), "put back in the queue by the assessment 4m ago");
  assert.equal(requeuedWords(requeue({ by: "hand" }), "running", NOW), "put back in the queue from the phone 4m ago");
});

test("…and reads differently in each state, because it means something different", () => {
  // Failed leads with the judgement about the WORK; burying "it failed again"
  // under the re-queue is the one reading that loses the fact.
  assert.match(requeuedWords(requeue(), "failed", NOW), /^failed again — it was put back in the queue/);
  // Done is the case for the verb existing, and says so in those words.
  assert.match(requeuedWords(requeue(), "done", NOW), /^ran after being put back in the queue/);
});

test("`run` is a re-RUN, not a place in a queue the row is not in", () => {
  // `by: "run"` is the first half of *run it now* — the backlog's `re-fire` and
  // Activity's *run it now* — which revives the row and fires it in the same
  // breath. Worded like its siblings it said "put back in the queue from the
  // phone 3s ago" about a row that was starting as you read it.
  const ran = requeuedWords(requeue({ by: "run" }), "running", NOW);
  assert.equal(ran, "started again 4m ago");
  assert.doesNotMatch(ran, /queue/);
  // The state frames still apply — it is the same fact in three lights.
  assert.match(requeuedWords(requeue({ by: "run" }), "failed", NOW), /^failed again — it was started again 4m ago/);
  assert.match(requeuedWords(requeue({ by: "run" }), "done", NOW), /^ran after being started again 4m ago/);
  // …and the two taps that leave the row WAITING keep their own wording.
  assert.match(requeuedWords(requeue({ by: "assess" }), "queued", NOW), /^put back in the queue by the assessment/);
  assert.match(requeuedWords(requeue({ by: "hand" }), "queued", NOW), /^put back in the queue from the phone/);
});

test("with no count from the host there is NO ordinal, never an invented one", () => {
  // `n` is `Intent.requeueCount` and is optional: absent means the host cannot
  // say how many times — every row re-queued before it counted. The sentence is
  // then drawn without the ordinal. It must never fall back to the length of
  // the capped history (frozen at five, so it says "(5th time)" on the ninth),
  // and it must never assume one: a reading degrades to absent, never to a
  // wrong number.
  const none = requeuedWords({ at: NOW - 4 * 60_000, by: "assess" }, "queued", NOW);
  assert.equal(none, "put back in the queue by the assessment 4m ago");
  assert.doesNotMatch(none, /time\)/);
  // The rest of the sentence is unaffected — an absent count is not an absent
  // failure.
  assert.match(
    requeuedWords({ at: NOW - 4 * 60_000, by: "hand", error: "tests failed" }, "failed", NOW),
    /^failed again — it was put back in the queue from the phone 4m ago · failed before: “tests failed”$/,
  );
});

test("the count is said past one, and the old failure is quoted only when there was one", () => {
  assert.doesNotMatch(requeuedWords(requeue({ n: 1 }), "queued", NOW), /time\)/);
  assert.match(requeuedWords(requeue({ n: 2 }), "queued", NOW), /\(2nd time\)/);
  assert.match(requeuedWords(requeue({ n: 3 }), "queued", NOW), /\(3rd time\)/);
  assert.match(requeuedWords(requeue({ n: 4 }), "queued", NOW), /\(4th time\)/);
  assert.match(requeuedWords(requeue({ n: 11 }), "queued", NOW), /\(11th time\)/);
  assert.match(requeuedWords(requeue({ n: 21 }), "queued", NOW), /\(21st time\)/);
  // `BacklogItem.error` is cleared the moment the row runs again, so without
  // this the reason somebody had to think twice is gone exactly when they are
  // deciding whether to think twice again.
  assert.match(requeuedWords(requeue({ error: "tests failed" }), "queued", NOW), /· failed before: “tests failed”/);
  assert.doesNotMatch(requeuedWords(requeue(), "queued", NOW), /failed before/,
    "an entry that recorded no failure text must not render an empty quote");
});

// ── The KIND axis, and the verb that fills it ───────────────────────────────

test("a kind is a BUCKET, and absent is one of them", () => {
  // `naming.ts`'s rule, on the phone's side of it: absent means NOBODY SAID,
  // which is a real answer and the one the naming verb exists to change. It is
  // never rounded to a category — a row filed under a heading its author never
  // chose is a row they will not think to look under.
  assert.equal(categoryBucket({ category: "bug" }), "bug");
  assert.equal(categoryBucket({}), "none");
  assert.equal(categoryBucket({ category: undefined }), "none");
  // `null` in the FILTER is not `"none"` in the bucket: one shows everything,
  // the other shows exactly the rows nothing has said anything about.
  assert.equal(hasBacklogFilter({ ...NO_BACKLOG_FILTER, category: "none" }), true);
  assert.equal(hasBacklogFilter({ ...NO_BACKLOG_FILTER, category: null }), false);
});

test("the kind chips are cross-counted, and a chip saying 2 opens exactly two", () => {
  // The rule this whole file exists for, on a third axis. With `failed` already
  // on, `bug 2` has to mean two FAILED bugs, because that is the list its tap
  // opens — and the count and the cut come from the one bucketing function.
  const items = [
    item({ id: "a", status: "failed", category: "bug" }),
    item({ id: "b", status: "failed", category: "bug" }),
    item({ id: "c", status: "queued", category: "bug" }),
    item({ id: "d", status: "failed", category: "chore" }),
    item({ id: "e", status: "failed" }),                    // nobody said
  ];
  const f = { ...NO_BACKLOG_FILTER, status: "failed" };
  const counts = backlogCounts(items, f, NOW);
  assert.equal(counts.category.bug, 2, "the queued bug is not in the cut the chip opens");
  assert.equal(counts.category.chore, 1);
  assert.equal(counts.category.none, 1, "the un-named row is countable — it is what the naming verb is for");
  assert.equal(counts.category.feature, 0);
  for (const c of ["bug", "chore", "none"]) {
    assert.equal(cut(items, { ...f, category: c }).length, counts.category[c], c);
  }
  // …and the other way round: with a kind on, the status chips count inside it.
  const byKind = backlogCounts(items, { ...NO_BACKLOG_FILTER, category: "bug" }, NOW);
  assert.equal(byKind.status.failed, 2);
  assert.equal(byKind.status.queued, 1);
  // The age chips too — three axes, each counted against the other two.
  assert.equal(backlogCounts(items, { ...NO_BACKLOG_FILTER, category: "chore" }, NOW).age.hour, 1);
});

test("the bar names the kind as a noun, and says what “no kind” is", () => {
  assert.match(backlogFilterSentence({ ...NO_BACKLOG_FILTER, category: "bug" }), /bugs/);
  assert.match(backlogFilterSentence({ ...NO_BACKLOG_FILTER, category: "feature" }), /features/);
  assert.match(backlogFilterSentence({ ...NO_BACKLOG_FILTER, category: "enhancement" }), /enhancements/);
  assert.match(backlogFilterSentence({ ...NO_BACKLOG_FILTER, category: "chore" }), /chores/);
  // Not "showing no kind", which reads as a list with nothing in it.
  assert.match(backlogFilterSentence({ ...NO_BACKLOG_FILTER, category: "none" }), /with no kind/);
  // Every dimension in one sentence, in the order the chips are read.
  assert.equal(
    backlogFilterSentence({ status: "failed", category: "bug", age: "day", ids: null }),
    "showing failed · bugs · added in the past 24h",
  );
});

test("the chip label is the shared word, and the title says what the tap does", () => {
  assert.equal(CATEGORY_CHIP_LABEL.bug, "bug");
  assert.equal(CATEGORY_CHIP_LABEL.none, NO_CATEGORY_LABEL);
  // An active chip CLEARS: a filter with no way out is a list that is simply
  // wrong, and on a phone the bar is a scroll away from the rows it is cutting.
  assert.match(categoryChipTitle("bug", true), /every kind again/);
  assert.match(categoryChipTitle("bug", false), /only the bugs/);
  assert.match(categoryChipTitle("none", false), /nothing has said a kind for/);
});

test("the naming verb counts the rows it will touch, and nothing else", () => {
  const nameable = [
    { id: "a", text: "fix the flaky upload test", status: "queued" },
    { id: "b", text: "the picker drops a worktree", status: "failed", category: "bug" },      // no title
    { id: "c", text: "tidy the schedule card", status: "queued", headline: "schedule card" }, // no kind
  ];
  const left = [
    // Both halves already there — re-titling would be the pass overwriting its
    // own earlier answer.
    { id: "d", text: "x", status: "queued", headline: "a title", category: "chore" },
    // A title somebody TYPED counts as a title (`itemHeadline`'s one rule), so
    // this row needs only its kind — and with one, it is left alone.
    { id: "e", text: "x", status: "queued", label: "inbox triage", category: "bug" },
    { id: "f", text: "x", status: "done" },
    { id: "g", text: "x", status: "running" },
    { id: "h", text: "x", status: "queued", archived: true },
  ];
  assert.deepEqual(nameableInCut([...nameable, ...left]), ["a", "b", "c"]);
  // A label that is the first 40 characters of the row's own words is a
  // truncation and not a title, so such a row is still nameable.
  const text = "For this and all other things that need doing, please check the inbox first";
  assert.deepEqual(nameableInCut([{ id: "t", text, label: text.slice(0, 40), status: "queued", category: "chore" }]), ["t"]);
});

test("the naming bar counts the cut on screen, and says what it leaves alone", () => {
  assert.equal(nameLabel(1), "name this one");
  assert.equal(nameLabel(7), "name these 7");
  // `dropClocksNote`'s rule — never describe a remainder that is not there.
  assert.match(nameNote(5, 5), /all 5 rows here/);
  assert.doesNotMatch(nameNote(5, 5), /the rest/);
  assert.match(nameNote(3, 9), /3 of the 9 shown/);
  assert.match(nameNote(3, 9), /the rest have both/);
  // …and SHORT. This bar is drawn over every backlog, so its words are chrome
  // above the list on the screen whose whole job is the list: the long form
  // measured 213 px of an 850 px phone.
  assert.ok(nameNote(3, 9).length <= 140, `the bar is a line, not a paragraph; it is ${nameNote(3, 9).length} chars`);
  // The protection is said where the tap is: it is the only thing standing
  // between a naming run and words somebody typed.
  for (const n of [nameNote(5, 5), nameNote(3, 9)]) {
    assert.match(n, /Nothing you typed is replaced/);
  }
  // What it SPENDS, and what it READS — the second is why it cannot be wrong
  // about anything but a title.
  assert.match(NAME_COST_NOTE, /cheap model/);
  assert.match(NAME_COST_NOTE, /own words and nothing else/);
  // The receipt says the verb that was ON the button, so there is no second
  // spelling of the count to drift — and it promises the QUEUE, never the
  // result: the pass is a call the desktop has yet to make.
  assert.match(namingToast(nameLabel(7)), /name these 7/);
  assert.doesNotMatch(namingToast(nameLabel(7)), /titled\b/);
  assert.match(namingToast(nameLabel(7)), /typed yourself is left alone/);
});

test("whose title it is, as words — never a tooltip", () => {
  // A title is the one string here a machine wrote over words a person wrote,
  // so who wrote it is visible text (`Unavailable.tsx`'s rule). Three authors,
  // three sentences: an author with no wording is an author a screen cannot say.
  assert.match(HEADLINE_BY_WORDS.assess, /assessment/);
  assert.match(HEADLINE_BY_WORDS.name, /naming pass/);
  assert.match(HEADLINE_BY_WORDS.hand, /you/);
  assert.equal(new Set(Object.values(HEADLINE_BY_WORDS)).size, 3, "three authors, three claims");
});

test("the edit form says the one consequence of saving a title, and the way back", () => {
  // These two were inline literals in `Backlog.tsx` — the only sentences on
  // this sheet that were not here, and the pair making the strongest claim:
  // that no assessment and no naming pass will touch the field again. A promise
  // about the host's `hand` stamp that nothing pins goes stale the first time
  // that stamp's rule is edited.
  const mine = headlineEditHint("hand");
  const suggested = headlineEditHint("assess");
  // Two states, two wordings. On a row already stamped `hand` the protection is
  // a FACT; on a suggestion it is a CONSEQUENCE of the tap about to be made,
  // and offering a person something they already have is how a form stops being
  // read at all.
  assert.match(mine, /this title is yours/);
  assert.match(suggested, /saving makes it yours/);
  assert.notEqual(mine, suggested);
  // A row the naming pass titled reads the same as one the assessment titled —
  // what differs is whose it is, which `HEADLINE_BY_WORDS` says on the row.
  assert.equal(headlineEditHint("name"), suggested);
  // …and an un-named row is not "a person said nothing" either: absent is the
  // suggestion wording, because that is the state a save would change.
  assert.equal(headlineEditHint(undefined), suggested);
  // **Both halves say the way back**, which is what makes the consequence cheap:
  // emptying the field clears the title AND its author, so a later pass may name
  // the row again.
  for (const h of [mine, suggested]) {
    assert.match(h, /Clear the field/);
    assert.match(h, /suggest one again/);
    assert.match(h, /assessment and the naming pass/);
  }
});

/**
 * **Is the cut on screen going to run?** — the sentence an ids cut needs,
 * because somebody arriving at one has just decided something somewhere else
 * and that is the only question they have.
 *
 * It took a COUNT and a boolean once, and an ids base is the one base where a
 * count is not enough: it is `inRepo` and holds archived rows on purpose, so
 * `merged from 3` — three originals whose never-running is the point of a merge
 * — was answered *"these 3 start one at a time in this repo, each in a session
 * of its own, in the order you see"*. Four claims, four of them false. So it
 * takes the BREAKDOWN, and every clause below is pinned to the rows it is true
 * of.
 */
/** A breakdown with only the fields a case is about; the rest are 0. */
const bd = (o) => ({ fresh: 0, aimed: 0, held: 0, other: 0, ...o });

test("the focused cut says whether anything is going to work through it", () => {
  const on = focusRunWords(bd({ fresh: 3 }), true, false);
  assert.match(on, /auto is on/);
  assert.match(on, /one at a time/, "the host serializes per repo — this describes it, it does not do it");
  assert.match(on, /session of its own/, "a fresh item opens its own conversation when it fires");
  assert.match(on, /order you see/);
  assert.match(on, /fire/, "the per-row control that already exists is the other answer");

  const off = focusRunWords(bd({ fresh: 3 }), false, false);
  assert.match(off, /auto is off/);
  assert.match(off, /none of these 3 start on their own/, "the refusal is a sentence about THESE rows");
  assert.match(off, /Turn auto back on/, "the remedy is the switch this sheet already has");
  assert.notEqual(on, off);
});

test("one row is worded as one, and a cut nothing starts in promises nothing", () => {
  // One row is not a queue, so it does not get the queue's sentence.
  assert.match(focusRunWords(bd({ fresh: 1 }), true, false), /this one starts when the repo is free/);
  assert.doesNotMatch(focusRunWords(bd({ fresh: 1 }), true, false), /one at a time/, "there is nothing for one row to be in order with");
  assert.match(focusRunWords(bd({ fresh: 1 }), false, false), /this one does not start on its own/);
  assert.match(focusRunWords(bd({ fresh: 1 }), false, false), /Turn auto back on/);
  // Nothing on screen is nothing to promise about, and the bar above already
  // says the cut is empty.
  assert.equal(focusRunWords(bd({}), true, false), null);
  assert.equal(focusRunWords(bd({}), false, false), null);
});

/**
 * **`merged from 3` is three ARCHIVED rows** — the cut this sentence was most
 * often drawn over, and the one it was most wrong about. An ids cut takes the
 * unhidden base deliberately (the originals of a merge are archived; that is
 * what a merge IS), so the rows are on screen and none of them will ever start.
 */
test("a cut of rows that cannot start says nothing rather than something false", () => {
  assert.equal(focusRunWords(bd({ other: 3 }), true, false), null, "three archived originals start nothing");
  assert.equal(focusRunWords(bd({ other: 3 }), false, false), null, "and auto has nothing to do with it");
  // A schedule child cut is routinely `done` or `failed`; *Aimed at a session
  // that closed* is `blocked` on `sessionGone` for ever and is out of
  // `nextFireIds`. Neither is about to run.
  assert.equal(focusRunWords(bd({ other: 2, held: 1 }), true, false), null);
  assert.equal(focusRunWords(bd({ held: 4 }), true, false), null, "held is not started");
  // One row that WILL start beside rows that will not: the sentence is about
  // the one, and says how many it is not about.
  const mixed = focusRunWords(bd({ fresh: 1, other: 3 }), true, false);
  assert.match(mixed, /this one starts/);
  assert.match(mixed, /other 3 here are not going to start/, "what is on screen and is not starting is counted, never claimed");
  assert.match(mixed, /each row says why/, "held is four reasons and the row already carries its own");
  assert.doesNotMatch(focusRunWords(bd({ fresh: 2 }), true, false), /not going to start/, "with nothing left over there is no clause");
});

/**
 * **"each in a session of its own" is a FRESH row's promise.** A row with a
 * `targetSessionId` runs in that conversation — the group head two lines above
 * already reads *In <session>* — and several open sessions start in PARALLEL,
 * so "one at a time in this repo" is false as soon as one is aimed.
 */
test("an aimed row is worded as aimed, never as a session of its own", () => {
  const aimed = focusRunWords(bd({ aimed: 2 }), true, false);
  assert.doesNotMatch(aimed, /session of its own/, "these run in the session they name");
  assert.match(aimed, /in their sessions/);
  assert.doesNotMatch(aimed, /one at a time in this repo/, "nextFireIds picks one per GROUP, so groups run at once");
  assert.doesNotMatch(aimed, /order you see/, "their order is their session's, not this flat list's");

  const one = focusRunWords(bd({ aimed: 1 }), true, false);
  assert.match(one, /the session it is aimed at/);
  assert.doesNotMatch(one, /session of its own/);

  // Mixed: two promises, and the only claim made about both is the wait.
  const mix = focusRunWords(bd({ fresh: 2, aimed: 1 }), true, false);
  assert.match(mix, /of these 3/);
  assert.match(mix, /2 start in a session of their own/);
  assert.match(mix, /1 in the session it is aimed at/);
  assert.doesNotMatch(mix, /one at a time in this repo/);
});

/**
 * **The smart pick is the one feature here that applies itself**, so with it on
 * the list on screen is explicitly NOT the fire order — and the sentence that
 * said it was is the sentence somebody reads before walking away.
 */
test("with the smart pick on, the visible order is not claimed as the order", () => {
  const smart = focusRunWords(bd({ fresh: 4 }), true, true);
  assert.doesNotMatch(smart, /order you see/);
  assert.match(smart, /smart pick chooses which one goes next/, "it says what decides instead, rather than going quiet");
  assert.match(focusRunWords(bd({ fresh: 4 }), true, false), /order you see/, "and with it off the order is the order");
  // One row has no order to be in either way.
  assert.doesNotMatch(focusRunWords(bd({ fresh: 1 }), true, true), /smart pick chooses/);
});

test("the switch the sentence names and the button that flips it are one string", () => {
  assert.equal(FOCUS_AUTO_ON_LABEL, "turn auto on");
  // The sentence tells you to turn auto back on; the control beside it must not
  // be wearing a different verb for the same tap.
  assert.match(focusRunWords(bd({ fresh: 2 }), false, false), /auto/);
  // And the button's TITLE is a sentence like every other, pinned here rather
  // than written inline in the component.
  assert.match(FOCUS_AUTO_ON_TITLE, /auto/);
  assert.match(FOCUS_AUTO_ON_TITLE, /this sheet's head/, "it names where the same switch already lives");
});

/**
 * **The edit form's session picker must be able to say what the row says.**
 *
 * The regression this pins: a row aimed at a session that has closed was drawn
 * with *A new session (default)* selected while the field still held the dead
 * id, so choosing the option already on screen fired no change, `saveEdit` sent
 * no patch, and Save saved nothing in silence — on the one row whose group head
 * and whose refusal notes both tell a person to edit it and take the aim off.
 */
test("editTargetOptions keeps a closed target selectable", () => {
  const live = [{ id: "s1", title: "one" }, { id: "s2", title: "two" }];
  const opts = editTargetOptions(live, "dead");
  assert.deepEqual(opts.map((o) => o.value), ["", "s1", "s2", "dead"]);
  assert.equal(opts[0].label, NEW_SESSION_OPTION);
  assert.equal(opts[3].label, CLOSED_TARGET_OPTION);
  // The value the form holds is always in the list, so the select cannot show
  // one answer while the patch carries another.
  assert.ok(opts.some((o) => o.value === "dead"));
});

test("editTargetOptions names each session the way every other picker does", () => {
  // Two sessions open in one repo share a `title` — it is `<repo> · <branch>`
  // — so this select offered the same words twice and the aim, which is the
  // one thing this form exists to change, could not be chosen. The derived
  // name (`sessionPickLabel`) is what tells them apart, and it is generated
  // already: only the choosing screens were not reading it.
  const live = [
    { id: "s1", title: "myapp \u00b7 main", tabTitle: "fix the sheet" },
    { id: "s2", title: "myapp \u00b7 main" },
  ];
  const opts = editTargetOptions(live, "");
  assert.match(opts[1].label, /fix the sheet/);
  assert.notEqual(opts[1].label, opts[2].label);
  // A session the host has not named is exactly what it always was — never a
  // trailing separator with nothing behind it.
  assert.equal(opts[2].label, "\u2192 myapp \u00b7 main");
});

test("editTargetOptions adds nothing for a live or absent target", () => {
  const live = [{ id: "s1", title: "one" }];
  assert.deepEqual(editTargetOptions(live, "s1").map((o) => o.value), ["", "s1"]);
  assert.deepEqual(editTargetOptions(live, "").map((o) => o.value), ["", "s1"]);
  // Nothing to choose between: one option is not a question, and the caller
  // draws no select at all.
  assert.equal(editTargetOptions([], "").length, 1);
  // …but a dead aim with no live session IS a question — taking it off is the
  // whole move, and the form used to draw no select at all in that case.
  assert.deepEqual(editTargetOptions([], "dead").map((o) => o.value), ["", "dead"]);
});


// ── Several items on ONE clock are a queue, and the queue is a fact ──────────
//
// Twelve live one-offs on this desktop were armed for the same weekly reset,
// seven of them in one repo, and nothing on the phone said which went first:
// the host sorts on `order ?? createdAt`, which is a creation time nobody is
// shown. These four functions are that queue, said out loud.

test("rows are grouped by the clock they share, in the order the list gives them", () => {
  const at = { rule: { kind: "once", at: NOW + 2 * H }, graceMin: 120, nextAt: NOW + 2 * H };
  const other = { rule: { kind: "once", at: NOW + 5 * H }, graceMin: 120, nextAt: NOW + 5 * H };
  const rows = [
    item({ id: "a", at }),
    item({ id: "plain" }),
    item({ id: "b", at }),
    item({ id: "c", at: other }),
  ];
  const gs = clockGroups(rows);
  assert.deepEqual(gs.map((g) => g.items.map((i) => i.id)), [["a", "b"], ["c"]]);
  // The run order is the LIST's order — grouping must never sort again, or the
  // sheet would be a second answer to "what runs first".
  assert.deepEqual(clockSeat(gs, "b"), { idx: 1, of: 2 });
  assert.equal(clockSeatWords({ idx: 1, of: 2 }), "2nd of 2 on this clock");
  // One row alone on its clock is not a queue, so it says nothing.
  assert.equal(clockSeat(gs, "c"), null);
  assert.equal(clockSeat(gs, "plain"), null);
});

test("the same instant graced or held differently is a DIFFERENT clock", () => {
  // `clockKey` is `@waterplane/shared`'s — the same function the host's merge rule
  // decides "the identical clock" with. Two spellings would let this sheet
  // group two rows the pass would never sequence together.
  const rule = { kind: "once", at: NOW + 2 * H };
  const a = item({ id: "a", at: { rule, graceMin: 120, nextAt: NOW + 2 * H } });
  const b = item({ id: "b", at: { rule, graceMin: 30, nextAt: NOW + 2 * H } });
  const c = item({ id: "c", at: { rule, graceMin: 120, nextAt: NOW + 2 * H }, holdForHost: true });
  assert.notEqual(itemClockKey(a), itemClockKey(b));
  assert.notEqual(itemClockKey(a), itemClockKey(c));
  assert.equal(itemClockKey(item({ id: "d" })), null);
  assert.equal(clockGroups([a, b, c]).length, 3);
});

test("the group's head says the instant, the count and that they go one at a time", () => {
  const at = { rule: { kind: "once", at: NOW + 2 * H }, graceMin: 120, nextAt: NOW + 2 * H };
  const g = clockGroups([item({ id: "a", at }), item({ id: "b", at })])[0];
  const w = clockGroupWords(g, NOW);
  assert.match(w, /2 items on one clock/);
  assert.match(w, /in 2h/);
  // A group with nothing armed says so rather than inventing an instant.
  const win = { kind: "window", window: "weekly", edge: "after", offsetMin: 0, oneShot: true };
  const pending = clockGroups([item({ id: "p", at: { rule: win, graceMin: 120, nextAt: null } }),
    item({ id: "q", at: { rule: win, graceMin: 120, nextAt: null } })])[0];
  assert.match(clockGroupWords(pending, NOW), /waiting for a usage reading/);
  assert.doesNotMatch(clockGroupWords(pending, NOW), /NaN|Invalid/);
  // The hold is the group's, said once, where it is true of every member.
  const held = clockGroups([item({ id: "h1", at, holdForHost: true }), item({ id: "h2", at, holdForHost: true })])[0];
  assert.match(clockGroupWords(held, NOW), /held until the desktop is free/);
});

test("the chip's count IS the cut it opens, and the cut composes with the others", () => {
  const at = { rule: { kind: "once", at: NOW + 2 * H }, graceMin: 120, nextAt: NOW + 2 * H };
  const rows = [
    item({ id: "a", at }),
    item({ id: "b", at, status: "failed" }),
    item({ id: "plain" }),
  ];
  assert.deepEqual(onClockIds(rows), ["a", "b"]);
  const f = { ...NO_BACKLOG_FILTER, clock: true };
  assert.deepEqual(rows.filter((it) => matchesBacklogFilter(it, f, NOW)).map((i) => i.id), ["a", "b"]);
  // Cross-counted like every other axis: with `failed` on, the clock chip says
  // how many FAILED rows have a clock, because that is what its tap opens.
  assert.equal(backlogCounts(rows, NO_BACKLOG_FILTER, NOW).clock, 2);
  assert.equal(backlogCounts(rows, { ...NO_BACKLOG_FILTER, status: "failed" }, NOW).clock, 1);
  // …and the status chips are counted inside the clock cut the same way.
  assert.equal(backlogCounts(rows, f, NOW).status.queued, 1);
  assert.match(backlogFilterSentence(f), /on a clock/);
});

test("re-time many: one edge for the box, the count and the frames", async () => {
  const { retimeEligible, retimeNote, retimeToast } = await import("./backlogFilter.ts");
  const row = (o) => ({ id: "x", text: "t", status: "queued", repoDir: "/r", ...o });
  const at = { rule: { kind: "once", at: 1, offsetMin: 0 }, graceMin: 120, nextAt: null };
  assert.equal(retimeEligible(row({})), true, "a queued row with no clock can be given one");
  assert.equal(retimeEligible(row({ at })), true);
  assert.equal(retimeEligible(row({ status: "failed", at })), true, "a failed TIMED row is revived by a new trigger");
  assert.equal(retimeEligible(row({ status: "failed" })), false, "a failed untimed row is run-it-again's, the host refuses a trigger on it");
  assert.equal(retimeEligible(row({ status: "running", at })), false);
  assert.equal(retimeEligible(row({ status: "done", at })), false);
  assert.equal(retimeEligible(row({ archived: true, at })), false);
  assert.match(retimeNote(2, 8, 8), /^2 of 8 picked\. /, "no clause about rows that are not there");
  assert.match(retimeNote(2, 6, 8), /2 have no box: running/, "the rows with no box are said in text");
  assert.equal(retimeToast(7, "Fr 09:00"), "re-timed 7 — the same rows, now Fr 09:00", "one tap, one receipt with the count");
});

test("re-time off the clock: the receipt says where the rows went", async () => {
  const { retimeQueuedToast, queuedChipHeld } = await import("./backlogFilter.ts");
  assert.equal(retimeQueuedToast(4, "next in line", ["garmin-monorepo"], "19:00"),
    "re-timed 4 — now next in line. Off the clock list: they wait in the queue, ⌛ on garmin-monorepo — held by the budget until 19:00.");
  assert.equal(retimeQueuedToast(1, "next in line", ["a", "b"], null),
    "re-timed — now next in line. Off the clock list: it waits in the queue, ⌛ on each repo's row.");
  assert.equal(queuedChipHeld(4, 0), "", "nothing held, bare count");
  assert.equal(queuedChipHeld(4, 4), " · budget");
  assert.equal(queuedChipHeld(4, 3), " · 3 budget");
});

test("the budget-waiver chip says the waiver, and its undo in text", async () => {
  const { PAST_BUDGET_CHIP, PAST_BUDGET_TITLE, pastBudgetChipWords, PAST_BUDGET_UNDONE_TOAST } = await import("./backlogFilter.ts");
  assert.equal(PAST_BUDGET_CHIP, "let past the budget");
  assert.equal(PAST_BUDGET_TITLE,
    "you let this past the usage budget — it still waits its turn; tap to hold it for the budget again");
  assert.equal(pastBudgetChipWords(true), "let past the budget · undo");
  assert.equal(pastBudgetChipWords(false), "let past the budget", "no undo offered where the tap cannot reach the desktop");
  assert.equal(PAST_BUDGET_UNDONE_TOAST, "held for the budget again");
});

// ── The session a serial row waits behind ──────────────────────────────────
//
// A row held `serial` used to say "waiting for 'myrepo' (working)" and offer
// nothing — the person had to find the session among five that share a title.
// The host now names the holder by id; the row offers to open it, worded for
// what the person will do there.
test("holderOffer: open the session a serial row waits behind, 'answer in' when it asks", async () => {
  const { holderOffer } = await import("./backlogFilter.ts");
  const row = { status: "queued", holderSessionId: "s1" };
  const s = (over = {}) => ({ id: "s1", running: true, title: "myrepo", ...over });
  assert.equal(holderOffer(row, [s({ tabTitle: "ios shell" })]).label, "open 'ios shell'");
  assert.equal(holderOffer(row, [s({ tabTitle: "ios shell", asking: { text: "go on?" } })]).label, "answer in 'ios shell'");
  assert.equal(holderOffer(row, [s({ tabTitle: "x", awaitingInput: true })]).label, "answer in 'x'");
  assert.equal(holderOffer(row, [s({ tabTitle: "x", prompt: { kind: "permission" } })]).label, "answer in 'x'");
  assert.equal(holderOffer(row, [s({ tabTitle: "x", prompt: { kind: "trust" } })]).label, "open 'x'", "a trust prompt is auto-accepted, not a question");
  // No derived name: the first prompt, never the bare repo title five sessions share.
  assert.equal(holderOffer(row, [s({ firstPrompt: "port the shell to capacitor\nand more" })]).label, "open 'port the shell to capacitor'");
  assert.equal(holderOffer(row, [s()]).label, "open 'myrepo'");
  assert.equal(holderOffer(row, [s()]).sessionId, "s1");
  // Nothing to open ⇒ no verb at all, never a dimmed one.
  assert.equal(holderOffer({ status: "queued" }, [s()]), null, "an older host sends no id");
  assert.equal(holderOffer(row, [s({ running: false })]), null, "the session is gone");
  assert.equal(holderOffer(row, []), null);
  assert.equal(holderOffer({ ...row, status: "running" }, [s()]), null, "only a waiting row waits behind anything");
});
