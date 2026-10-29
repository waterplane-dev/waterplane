/**
 * The COUNTS on the controls, and the sentences that name them — every number here is the
 * length of a cut, because a count on a control is a filter.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, BacklogStatus } from "@waterplane/shared";
import {
  BACKLOG_AGES, BACKLOG_STATUSES, CATEGORY_BUCKETS, categoryBucket, type BacklogAge, type CategoryBucket, withinAge,
} from "./rowBuckets.ts";
import { isFailedRow, statusBucket } from "./calledOff.ts";
import { type BacklogFilter } from "./rowFilter.ts";

/**
 * The numbers on the chips — each one counted against the OTHER dimension's
 * filter, never against the unfiltered list. With "failed" already on, the age
 * chips must say how many FAILED items are in each window, because that is the
 * list a tap opens. A count that describes a different cut than the tap
 * produces is the bug this file exists to not have.
 *
 * `ids` gets no chips of its own — it is not a dimension a person browses, it is
 * the cut one specific count opens — but it narrows BOTH of the others, for the
 * rule above. With "merged from 3" on, the status chips have to say how many of
 * THOSE three are failed, or the chip says 9 and the tap shows one.
 *
 * `pool` is each axis's own whole: the rows that pass the OTHER three axes, i.e. the list that
 * axis would be cutting. A chip whose count IS its pool opens the list already on screen, which
 * is what `drawnChips` leaves undrawn.
 */
export function backlogCounts(items: BacklogItem[], f: BacklogFilter, now: number) {
  const status = { running: 0, queued: 0, failed: 0, done: 0 } as Record<BacklogStatus, number>;
  const age = { hour: 0, day: 0, week: 0, older: 0 } as Record<BacklogAge, number>;
  const category = { bug: 0, feature: 0, enhancement: 0, chore: 0, none: 0 } as Record<CategoryBucket, number>;
  // The fourth axis, counted against the other three exactly as they are
  // against each other: with "failed" on, "on a clock 3" has to mean three
  // failed rows with a clock, because that is the list its tap opens.
  let clock = 0;
  const pool = { status: 0, age: 0, category: 0, clock: 0 };
  for (const it of items) {
    if (f.ids && !f.ids.includes(it.id)) continue;
    // Each axis counted against the OTHER two, exactly as the first two have
    // always been counted against each other: with "failed" and "past 24h"
    // already on, `bug 3` has to mean three failed bugs from the past 24 hours,
    // because that is the list its tap opens.
    const st = statusBucket(it);
    const okStatus = !f.status || st === f.status;
    const okAge = !f.age || withinAge(it.createdAt, f.age, now);
    const okCat = !f.category || categoryBucket(it) === f.category;
    const okClock = !f.clock || !!it.at;
    if (okAge && okCat && okClock) { status[st] = (status[st] ?? 0) + 1; pool.status++; }
    if (okStatus && okCat && okClock) {
      pool.age++;
      for (const a of BACKLOG_AGES) if (withinAge(it.createdAt, a, now)) age[a]++;
    }
    if (okStatus && okAge && okClock) { category[categoryBucket(it)]++; pool.category++; }
    if (okStatus && okAge && okCat) { pool.clock++; if (it.at) clock++; }
  }
  return { status, age, category, clock, pool };
}

/**
 * **Which chips are worth drawing** — the ONE place that decides, from the same counts the chips
 * print, so the number and the cut cannot disagree about whether a chip exists.
 *
 * A chip is drawn when it is LIT (its tap is the way out) or when its tap would change the list:
 * some rows, but not all of its pool. `past week 4` and `no kind 4` over a list of four open the
 * list already on screen, so they say a number the reader has to discard — "4" four times in one
 * sheet was the complaint. A chip with nothing in it was never drawn, and still is not.
 *
 * Two kinds of chip are drawn even when they hold the whole pool, because their tap is not only
 * a cut: `failed` and `done` are the doors to the bulk verbs (*run these N again*, *archive
 * these N* are drawn on that status cut alone, so hiding the chip over an all-done repo would
 * take the verb out of reach), and `on a clock` re-groups the rows by the instant they share.
 */
export function drawnChips(c: ReturnType<typeof backlogCounts>, f: BacklogFilter) {
  const drawn = (count: number, pool: number, lit: boolean, door = false) =>
    lit || (count > 0 && (door || count < pool));
  return {
    status: BACKLOG_STATUSES.filter((s) =>
      drawn(c.status[s], c.pool.status, f.status === s, s === "failed" || s === "done")),
    age: BACKLOG_AGES.filter((a) => drawn(c.age[a], c.pool.age, f.age === a)),
    category: CATEGORY_BUCKETS.filter((k) => drawn(c.category[k], c.pool.category, f.category === k)),
    clock: drawn(c.clock, c.pool.clock, !!f.clock, true),
  };
}

/**
 * **The cut on screen, sorted by what is actually going to happen to it** —
 * the input `focusRunWords` reads, and the thing a COUNT can never be.
 *
 * The sentence used to take `cut.length` and a boolean, and an ids cut is
 * precisely the base where a count says nothing true: it is `inRepo`, archived
 * rows included on purpose (`Backlog.tsx` — every original of a merge is
 * archived, which is the point of a merge), so `merged from 3` handed the
 * sentence three rows that will never start and got back *"these 3 start one at
 * a time, each in a session of its own, in the order you see"*. Four claims,
 * four of them false, on the one screen somebody opens to find out.
 *
 * So the facts are derived where `nextFireIds` already derives them, once, and
 * arrive here already counted. `Backlog.tsx` owns the predicates; this file owns
 * the words.
 */
export interface FocusRunBreakdown {
  /** `queued`, aimed at nothing, no clock still ahead — opens a session of its
   *  own when the repo is free. The only rows *a session of its own* is true of. */
  fresh: number;
  /** `queued` and aimed at a session that is OPEN — runs in THAT conversation,
   *  and in parallel with the other groups, so it is not "one at a time in this
   *  repo" either. */
  aimed: number;
  /** Waiting on something that is not the repo being free: a session that
   *  CLOSED (nothing re-aims one, so it waits for ever), or a clock that has not
   *  come (`▶ next` skips one for the same reason — it is not next, its clock
   *  is). Not started, not starting; its own row says which. */
  held: number;
  /** Everything else on screen: archived, running, done, failed. */
  other: number;
}

/**
 * **Whether anything is going to work through the cut on screen, in one
 * sentence.**
 *
 * An ids cut is where somebody arrives having just DECIDED something — an
 * assessment applied, a merge approved, a schedule's row followed — and the
 * next question is always the same one: *is this going to run?* The sheet could
 * only answer it by implication (a chip in the head reading `auto off`, next to
 * a list that had simply stopped moving), which is the failure the auto-off
 * banner already exists for; this says it about THESE rows, where they are.
 *
 * It describes what already happens and invents nothing — and every clause is
 * now conditional on the rows actually being what the clause claims, because
 * the first version said all of them unconditionally:
 *
 *   • **`null` when nothing in the cut is going to start.** `merged from 3` is
 *     three archived originals; a schedule child cut is routinely `done` or
 *     `failed`; *Aimed at a session that closed* is `blocked` for ever. Saying
 *     nothing is the only true thing available, and the rows say their own why.
 *   • **"in a session of its own" is a FRESH row's promise.** A row with a
 *     `targetSessionId` runs in that conversation — the group head two lines
 *     above already reads *In &lt;session&gt;* — so an aimed row is worded as
 *     one and never as a new session.
 *   • **"one at a time in this repo" only with no aimed rows.** `nextFireIds`
 *     picks one per GROUP, so fresh rows plus two open sessions start three at
 *     once, and the serialization claim is the host's per-session one.
 *   • **"in the order you see" only where the order IS the order.** With aimed
 *     rows in the cut the order is per session and not the flat list. Silence
 *     beats a half-truth.
 *
 * With auto OFF the refusal is a sentence and the remedy is named, never a
 * dimmed row: the switch that fixes it is the one in this sheet's own head, and
 * `fire` on a row is the other answer. Both already exist. **This is then the
 * only copy of "auto is off"** — `Backlog.tsx` drops its head banner exactly
 * when this sentence is drawn, so one rule is stated once.
 */
export function focusRunWords(b: FocusRunBreakdown, auto: boolean): string | null {
  const starting = b.fresh + b.aimed;
  // Nothing here is going to start, so there is no promise to make. The bar
  // above says what the cut is and every row says what state it is in; a
  // sentence claiming a start would be the one thing on screen that is wrong.
  if (starting <= 0) return null;
  const rest = b.held + b.other;
  // What is on screen and is NOT going to start, counted but not diagnosed:
  // "held" is four different reasons and each row already carries its own.
  const restWords = rest
    ? ` The other ${rest} here ${rest === 1 ? "is" : "are"} not going to start — each row says why.`
    : "";
  if (!auto) {
    // One row is not a queue, so it is worded as one.
    const subject = starting === 1
      ? "this one does not start on its own"
      : `none of these ${starting} start on their own`;
    const fire = starting === 1
      ? "tap fire on the row to start it now"
      : "tap fire on a row to start that one now";
    return `auto is off on this desktop, so ${subject}. Turn auto back on, or ${fire}.${restWords}`;
  }
  const fire = starting === 1 ? " fire on the row starts it now." : " fire on a row starts that one now.";
  // The order clause is drawn only where the flat list on screen IS the order
  // the host will take: no aimed rows (whose order is their session's, not
  // this list's).
  const order = b.aimed === 0 && starting > 1 ? ", in the order you see" : "";
  let lead: string;
  if (b.aimed === 0) {
    lead = b.fresh === 1
      ? "this one starts when the repo is free, in a session of its own"
      : `these ${b.fresh} start one at a time in this repo, each in a session of its own${order}`;
  } else if (b.fresh === 0) {
    lead = b.aimed === 1
      ? "this one starts in the session it is aimed at, as soon as that session is free"
      : `these ${b.aimed} start in their sessions, each as soon as its session is free`;
  } else {
    const aimedPart = b.aimed === 1 ? "1 in the session it is aimed at" : `${b.aimed} in their sessions`;
    lead = `of these ${starting}, ${b.fresh} start in a session of their own and ${aimedPart}, each as soon as what it waits for is free`;
  }
  return `auto is on: ${lead}.${fire}${restWords}`;
}

/** The label on the switch `focusRunWords` names, so the sentence and the
 *  button cannot come to say different things about one state. */
export const FOCUS_AUTO_ON_LABEL = "turn auto on";

/** …and the button's own title, here rather than inline in `Backlog.tsx`, for
 *  this file's whole reason: a claim about what a tap does is a user-facing
 *  sentence and belongs with the sentence it restates, pinned by the same test. */
export const FOCUS_AUTO_ON_TITLE =
  "turn the desktop's auto switch back on — the same switch as the chip in this sheet's head";

/**
 * The count under the filter bar — *what is hidden, against the unfiltered
 * list* — with the one clause that stops it describing a list nobody saw.
 *
 * An IDS cut counts against a base that includes archived rows, and it has to:
 * every original of a merge is archived, so counting an ids cut against the
 * default view would count it against a list that holds none of them. But the
 * DEFAULT view underneath does hide them, so "3 of 12" over a list drawing nine
 * was true about something the reader has never had on screen. The clause names
 * the base instead of quietly changing the number.
 */
export function backlogCountWords(cut: number, base: number, f: BacklogFilter): string {
  return `${cut} of ${base}${f.ids ? ", archived included" : ""}`;
}

/**
 * **Clearing out the finished, as one tap** — `dropClocksLabel`'s twin, and
 * held to the same rule.
 *
 * A repo that has been worked for a fortnight accumulates a `done` row per
 * item, and every one of them is a row you scroll past for ever to reach the
 * five that are still waiting. Archiving them one at a time is the same tap
 * repeated, which is the definition of the chore this bar exists to end.
 *
 * **A COUNT ON A CONTROL IS A FILTER**, so the number is the done rows in the
 * CUT ON SCREEN and the tap acts on exactly those — never on the repo's other
 * rows, and never on rows the archived hide is keeping out of view. Drawn on
 * the `done` cut alone, for the reason `bulkClockIds` is drawn on `failed`
 * alone: over an unfiltered list of sixty-two, "archive these 5" is a number
 * nobody can check against what they can see, and a bulk mutation nobody can
 * check is a bulk mutation nobody asked for. The `done N` chip IS the one tap
 * that gets there, and it is the same tap that shows you what you are about to
 * archive.
 *
 * Archiving is not deleting, which is why this is a `ConfirmButton` and not a
 * two-stage anything: the rows keep their words, `show archived (N)` keeps
 * counting them, and the per-row unarchive keeps working. The note says that,
 * because a person who reads "archive" as "throw away" will not press it — and
 * a person who presses it believing that is owed the truth first.
 */
export function archiveDoneLabel(n: number): string {
  return `archive ${n === 1 ? "this one" : `these ${n}`}`;
}
export function archiveDoneNote(n: number, shown: number): string {
  // n === shown is the ordinary case — this bar is drawn over the `done` cut,
  // where every row qualifies. The other branch is real anyway: with
  // `show archived` on, the cut also holds rows that are already archived, and
  // those are not touched. `dropClocksNote`'s rule — never describe a remainder
  // that isn't there — decides which sentence is said.
  const head = n === shown
    ? `every one of the ${shown} rows here is finished`
    : `${n === 1 ? "one row" : `${n} rows`} of the ${shown} shown ${n === 1 ? "is" : "are"} finished and not yet archived — the rest are already archived and are left alone`;
  return `${head}. Archiving is not deleting: the words stay, `
    + "the archived count keeps them, and any one of them can be brought back from its own row.";
}
/** One tap, one receipt — `dropClocksToast`'s rule: the wire has no batch
 *  `backlog.archive`, so the SENTENCE is the only place the count survives. */
export function archiveDoneToast(n: number): string {
  return n === 1
    ? "archived — its words stay, and show archived still lists it"
    : `${n} archived — their words stay, and show archived still lists them`;
}

/**
 * **What `assess` is being asked about, when a filter has made that a question.**
 *
 * `assess.run` carries the cut now (`ids`), so the button follows the list like
 * every other count on this screen — it was the one control whose number was
 * not its own tap, sitting under a bar that said *6 of 62*.
 *
 * **The number is the ASSESSABLE rows in the cut, not the cut.** An assessment
 * judges work that is still open; a finished or running row goes in as context
 * and `cleanAssessment` refuses any verdict naming one. So a cut of five `done`
 * rows has nothing to assess, and a button reading *assess these 5* over it
 * would spend an agent on a question with no candidates — which is why
 * `assessableInCut` is what the label counts and why zero of them removes the
 * button rather than dimming it.
 */
export function assessScopeLabel(n: number): string {
  return `assess ${n === 1 ? "this one" : `these ${n}`}`;
}
export function assessScopeNote(n: number, shown: number): string {
  // The two-number case is the common one here: a cut of seven rows of which
  // four are still open. `dropClocksNote`'s rule decides the shape — never
  // describe a remainder that is not there.
  const head = n === shown
    ? `every one of the ${shown} rows here is still open`
    : `${n === 1 ? "one row" : `${n} rows`} of the ${shown} shown ${n === 1 ? "is" : "are"} still open — the rest are finished or running and cannot be judged`;
  // **What a scoped run still reads.** Without this the sentence invites the
  // opposite reading — that scoping makes it look at less of the repo — when
  // the narrowing is only of what it may form a VERDICT about. The finished
  // rows and the code are the evidence either way, which is what makes the
  // scoped answer worth having.
  return `${head}. It still reads the whole repo as evidence — what narrows is which rows it may return a verdict on.`;
}
/**
 * …and the refusal, as a sentence, for a cut with nothing open in it.
 *
 * `Unavailable.tsx`'s rule: the button is ABSENT and this says why. A dimmed
 * one with the reason in a `title` is invisible on the only device this sheet
 * is used from.
 */
export const ASSESS_NONE_IN_CUT =
  "assess: nothing in this cut is still open — an assessment judges work that is waiting or failed, "
  + "and these rows are finished or running";

/** Which rows of a cut an assessment could actually form a verdict about.
 *  The host decides for real (`ASSESSABLE_STATES`, over intent states); this is
 *  the same question asked of the two backlog statuses that reach it, so the
 *  count on the button is the count the run will judge. */
export function assessableInCut(items: readonly Pick<BacklogItem, "id" | "status" | "archived" | "calledOff">[]): string[] {
  return items.filter((it) => !it.archived && (it.status === "queued" || isFailedRow(it))).map((it) => it.id);
}
