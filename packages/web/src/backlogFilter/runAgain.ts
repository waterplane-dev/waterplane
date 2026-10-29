/**
 * *run it again* — `drop the clock`'s sibling for the row with no clock — and what a revived
 * row says.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, BacklogStatus } from "@waterplane/shared";

/**
 * ── `run it again` — `drop the clock`'s sibling, for the row with no clock ───
 *
 * **The two verbs are the same shape and a different promise, and the reason
 * there are two is that a backlog has two kinds of dead row.**
 *
 * A one-off whose instant went by is stuck because of its CLOCK, and *drop the
 * clock* takes the instant off and leaves the words. A row that simply FAILED
 * is stuck for a different reason and has no clock to drop: it is terminal, the
 * ladder never looks at it again, and the only things this sheet offered were
 * `re-fire` (which starts an agent THIS SECOND, past every rung) and the
 * archive. On the desktop this was written on that was 0 queued rows against 19
 * failed — so the queue auto is fed from was empty while nineteen
 * pieces of live work sat one state away from it, and the assessment's *still
 * wanted* verdict, applied, did nothing at all.
 *
 * This is the verb that puts one back: `intent.requeue`, the words, the place
 * and the failure all kept, and the queue takes it from there. It is DURABLE
 * and safe to queue offline, unlike every other mutation on this sheet, and
 * that is a property of the message rather than a courtesy — the host refuses
 * anything that is not currently `failed`, so a delivery an hour after the tap
 * is either still exactly what the person meant or not applied at all.
 *
 * Every string is here, beside `dropClockNote`, for `ageBucket`'s reason: the
 * note under the chips, the title on the verb and the sentence in the receipt
 * are claims about one tap, and a second copy of any of them is how a tap
 * starts describing something else.
 */
export const RUN_AGAIN_LABEL = "run it again";
/**
 * **What the verb promises — as TEXT on the row, and as the button's `title`,
 * from ONE string, WORDED OFF THE ROW.**
 *
 * `dropClockNote`'s rule exactly, and it is the rule `Unavailable.tsx` exists
 * for: a `title` is invisible on the only device this app is used from, so a
 * claim that lives only there is a claim that was not made. Four things have to
 * be in it, and each of them is something a person cannot work out by looking:
 *
 *  - where the row goes (back in the queue — not "it runs", which is what the
 *    button beside it does);
 *  - **WHERE it runs when it gets there**, which is the clause this was wrong
 *    about: it was a flat *"a new session of its own"*, and that is only true
 *    of a `fresh` row. A row carrying `targetSessionId` — the sheet's *In
 *    &lt;session&gt;* group — runs in THAT conversation and nowhere else, and
 *    the promise of a session of its own is one the host was never going to
 *    keep. So the sentence reads the row, exactly as the GROUP HEADS do
 *    (`targetSessionId` absent ⇒ *Each in a new session*), and there is one
 *    rule deciding both;
 *  - what is NOT wiped (the failure it had stays on the row, so the reason it
 *    died is still readable after it has been revived);
 *  - and what the OTHER button does, because the two sit side by side and the
 *    difference between them — in turn versus this second — is the whole choice.
 *
 * `fresh` is deliberately NOT the field this branches on. It is optional and
 * absent on every row written before it existed, where absent means the retired
 * shared-session reading — a fact about an old row and never a control. What
 * actually decides where the words land is whether the row NAMES a session, and
 * that is `targetSessionId`, which is also what `groupKeyOf` reads. One rule.
 */
export function runAgainRowNote(it: Pick<BacklogItem, "targetSessionId">): string {
  const head = "it failed, so nothing will pick it up again — put it back in the queue and it runs again ";
  const tail = " The failure it had stays on the row. “re-fire” beside it runs it this second instead.";
  // A row aimed at a live session: the queue it goes back into is that
  // session's, auto fires it there when the conversation next goes quiet, and
  // saying "a session of its own" here would describe the one thing that will
  // not happen. What a person can rely on for this row is auto and that
  // session.
  if (it.targetSessionId) {
    return `${head}in the session it is aimed at, as soon as that session is free — auto takes it from there. `
      + `It does not open a session of its own.${tail}`;
  }
  return `${head}in a new session of its own when its turn comes, `
    + `where auto takes it from there.${tail}`;
}
/**
 * **…and what a failed row aimed at a session that has CLOSED says instead —
 * because it gets no verb at all.**
 *
 * The third group head on this sheet already says the state (*Aimed at a
 * session that closed*) and the row's own chip says *target closed — held*:
 * `sessionBlocker` holds such a row for as long as it exists, nothing re-aims
 * it, and the only re-aim anywhere is the usage-limit resurrection. Putting one
 * back in the queue therefore buys exactly nothing — it goes from a row that
 * has stopped to a row that waits for ever, which is worse, because the second
 * one looks like progress.
 *
 * So the verb is not drawn, and this is the sentence that says why. **Never a
 * dimmed button** (`Unavailable.tsx`): a refusal is words, and on a phone words
 * in a `title` are not words. It names the two taps that END the state, because
 * a sentence that only says no is a dead end — and it deliberately does NOT
 * offer *re-fire* as the way out: a hand fire resolves the same dead id.
 *
 * The host is growing a pre-flight refusal for this case as well. That is the
 * backstop for a frame already in flight; this is the phone not offering it.
 */
export function runAgainClosedNote(): string {
  return "it failed, and it is aimed at a session that has closed — nothing re-aims it, so putting it back in the queue "
    + "would only make it wait for ever instead of stopping. Edit it to pick another session, or take the aim off so it "
    + "opens a session of its own, and “run it again” comes back.";
}
/** What the row says back. Not "it is running": the host puts it back behind the
 *  ladder, so by the time this is read the row may be waiting on auto, on the
 *  repo, or on the desktop — the honest receipt is about the QUEUE.
 *
 *  It deliberately names no SESSION either. Where the words land is the row's
 *  own fact (`runAgainRowNote` reads `targetSessionId` for it) and the row is
 *  still on screen behind the toast; a receipt that guessed would be the same
 *  unkeepable promise one surface along. */
export const RUN_AGAIN_TOAST = "put back in the queue — it runs again when its turn comes";
/**
 * …and the same receipt for the BULK tap: **one tap, one receipt.**
 *
 * `dropClocksToast`'s rule and its reason: the wire has no batch
 * `intent.requeue`, so the app sends N frames and the SENTENCE is the only
 * place the count survives. Nineteen identical toasts for one tap is the
 * notification feed reporting one decision nineteen times and the number never.
 *
 * *one at a time* is gone from the plural. A cut can hold rows aimed at
 * DIFFERENT live sessions, and those run in parallel — so the clause was a
 * promise about scheduling that the host contradicts the moment two of the
 * nineteen name two conversations. What is true of every one of them is that
 * each waits its turn, and that is what it now says.
 */
export function runAgainToast(n: number): string {
  return n === 1
    ? RUN_AGAIN_TOAST
    : `${n} put back in the queue — they run again as their turns come`;
}

/** The row this sheet asks about, as this verb reads it. A `Pick`, so the call
 *  sites are free to hand over the whole `BacklogItem` and the function still
 *  states exactly which four fields the answer is made of. */
type RunAgainRow = Pick<BacklogItem, "status" | "at" | "archived" | "targetSessionId" | "calledOff">;

/**
 * **Which rows the verb covers — ONE function, for the row AND the cut.**
 *
 * There used to be two readings of "eligible": this list's, and a
 * `runAgainOffered` in `Backlog.tsx` restating `failed && !at && !archived`
 * beside a comment claiming it was "not a second copy". It was, and the failure
 * a second copy has here is specific — the bulk bar says *run these 19 again*
 * over a list where twenty rows wear the button, and neither number is checkable
 * against the other. The component now asks THIS function about one row.
 *
 * Three answers rather than a boolean, because the third state is not "no verb"
 * but "no verb, and here is why", which is a SENTENCE on the row
 * (`runAgainClosedNote`) and never a dimmed control:
 *
 *  - **`offered`** — `failed`, no clock, not archived, and either aimed at
 *    nothing or aimed at a session that is still running.
 *  - **`held-closed`** — everything above, except the session it names has
 *    gone. Nothing re-aims such a row (`sessionBlocker` holds it for as long as
 *    it exists), so a re-queue turns a stopped row into one that waits for
 *    ever. The sheet's third group head already says the state; this is what
 *    makes the phone stop OFFERING the tap, which is the half the host's own
 *    pre-flight refusal cannot do.
 *  - **`none`** — not this verb's business at all.
 *
 * **`failed`**, because that is the only state the host accepts a re-queue in
 * and the only one the verb means anything in.
 *
 * **No clock.** A failed row carrying an instant has its own verb two lines
 * over: *drop the clock* is what a one-off whose time went by needs, and it is
 * a different sentence about a different reason. Offering both on one row would
 * be two buttons for one tap with no way to tell which; offering this one alone
 * would put a row back in a queue it is still going to be pulled out of by an
 * instant that has already passed.
 *
 * **Not archived.** A row set aside is a row somebody put out of sight on
 * purpose, and reviving it is the reverse of what they said. Its own unarchive
 * is the one tap that brings it back to where this verb can see it.
 *
 * `liveSessionIds` is the RUNNING sessions, and it is a parameter rather than a
 * field on the row because "has that conversation exited" is a fact about the
 * host's live list and never about the item — the same reason `targetClosed`
 * has always been computed in the sheet against `p.sessions`.
 */
export function runAgainState(it: RunAgainRow, liveSessionIds: ReadonlySet<string>): "offered" | "held-closed" | "none" {
  if (it.status !== "failed" || it.calledOff || it.at || it.archived) return "none";
  if (it.targetSessionId && !liveSessionIds.has(it.targetSessionId)) return "held-closed";
  return "offered";
}
/** The predicate the button and the cut both ask, over `runAgainState`'s one
 *  edge. Named because a call site reading `=== "offered"` is a call site that
 *  can be written `!== "none"` by mistake. */
export function runAgainEligible(it: RunAgainRow, liveSessionIds: ReadonlySet<string>): boolean {
  return runAgainState(it, liveSessionIds) === "offered";
}
/** The cut, built from the same predicate the row's button is drawn from — so
 *  the number on the bar and the rows wearing the verb cannot disagree. */
export function runAgainIds(
  items: readonly (RunAgainRow & Pick<BacklogItem, "id">)[],
  liveSessionIds: ReadonlySet<string>,
): string[] {
  return items.filter((it) => runAgainEligible(it, liveSessionIds)).map((it) => it.id);
}
/** …and how many of an eligible cut are aimed at a live session rather than
 *  opening one of their own. It is what lets `runAgainNote` say where the words
 *  will land without guessing — the same partition, counted. */
export function runAgainAimedCount(
  items: readonly RunAgainRow[],
  liveSessionIds: ReadonlySet<string>,
): number {
  return items.filter((it) => runAgainEligible(it, liveSessionIds) && !!it.targetSessionId).length;
}
/** **A count on a control is a filter**: the number is the eligible rows in the
 *  cut ON SCREEN and the tap acts on exactly those. `dropClocksLabel`'s shape,
 *  one state along. */
export function runAgainLabel(n: number): string {
  return `run ${n === 1 ? "this one" : `these ${n}`} again`;
}
/**
 * The note above the bulk button. `aimed` is how many of the `n` name a live
 * session (`runAgainAimedCount`), and it is a parameter for the reason
 * `runAgainRowNote` reads the row: *each in a session of its own* is true of a
 * `fresh` row and false of an aimed one, and a bulk bar over a mixed cut was
 * making the false half of that promise about rows a reader can see on screen.
 * With the two counts in hand the sentence simply says which is which.
 */
export function runAgainNote(n: number, shown: number, aimed = 0): string {
  // `dropClocksNote`'s rule — never describe a remainder that is not there.
  // The two-number case is the common one here: this bar is drawn over the
  // `failed` cut, where a row with a clock, a row aimed at a session that has
  // closed, or a row already set aside is left alone, and each of those is
  // identifiable on screen by its own chip.
  const head = n === shown
    ? `every one of the ${shown} rows here can go back in the queue`
    : `${n === 1 ? "one row" : `${n} rows`} of the ${shown} shown can go back in the queue — the rest carry a clock (they wear “drop the clock”), `
      + "are aimed at a session that closed, or are set aside, and are left alone";
  // Three wordings, because the cut is one of three things and a single
  // sentence would be wrong about two of them. Only the all-fresh branch may
  // say "one at a time in this repo": rows aimed at DIFFERENT sessions run in
  // parallel, so that clause is a scheduling promise the host contradicts the
  // moment the cut is mixed.
  const where = aimed === 0
    ? "They run again one at a time in this repo, each in a session of its own, as their turns come — auto takes it from there"
    : aimed === n
      ? `They run again in the session${n === 1 ? "" : "s"} they are aimed at, as ${n === 1 ? "it comes" : "those come"} free — auto takes ${n === 1 ? "it" : "them"} from there`
      : `${n - aimed} run again in a session of its own, one at a time in this repo, and ${aimed} in the session${aimed === 1 ? "" : "s"} `
        + `${aimed === 1 ? "it names" : "they name"}, as those come free — auto takes them from there`;
  return `${head}. ${where}, and the failure each one had stays on its row.`;
}

/**
 * **What a row that has already been put back says about itself.**
 *
 * A revived row is otherwise indistinguishable from one that was never in
 * trouble — same `queued`, same place in the list — and that is the one thing
 * about it a person needs: it is here because somebody (or an assessment they
 * approved) decided it was still worth doing, and it died once already.
 *
 * Four sentences, because the fact reads differently in each state the row can
 * be in by the time it is read, and one wording for all four would be wrong in
 * three of them:
 *
 *  - **queued / running** — the plain statement: this was put back, by whom,
 *    how long ago.
 *  - **failed** — it was put back and it failed AGAIN, which is a judgement
 *    about the work and not about the tap, and leading with the re-queue would
 *    bury it.
 *  - **done** — it was put back and it WORKED, which is the whole case for the
 *    verb existing and is worth saying in those words.
 *
 * ── `by: "run"` is a fourth sentence, not a third spelling of one ───────────
 *
 * `assess` and `hand` are two taps that leave the row WAITING, so both are
 * *put back in the queue* and differ only in who did it. **`run` is not one of
 * those.** It is the first half of *run it now* — the backlog's `re-fire` and
 * Activity's *run it now* — which revives the row and fires it in the same
 * breath, so the row the sentence is drawn on is starting or already running.
 * Worded like its siblings it read *"put back in the queue from the phone 3s
 * ago"* on a row that was fired this second and is in no queue at all, which is
 * a claim about where somebody's work is sitting, made about the one case where
 * it is not sitting anywhere. It says *started again*.
 *
 * ── the ordinal is ABSENT rather than wrong ────────────────────────────────
 *
 * `(2nd time)` is drawn from `n` and only past one, because "this is the third
 * time" is the entire content the older entries the host keeps would have
 * carried anyway. **`n` is optional**, and absent means the host cannot say how
 * many times — every row re-queued before it counted, and any row whose count
 * the host lost. The sentence is then drawn WITHOUT an ordinal. It must never
 * fall back to the length of `requeues` (capped at `REQUEUE_KEEP`, so it freezes
 * at five and then says *(5th time)* on the ninth), nor to a bare `1`: this
 * repo's rule is that a reading degrades to absent, never to a wrong number, and
 * a frozen ordinal on a chip that reads as a warning is exactly the failure that
 * rule is written against.
 *
 * The quoted failure is the one THAT entry recorded: it is gone from
 * `BacklogItem.error` the moment the row runs again, so without this the reason
 * a person had to think twice disappears at exactly the moment they are
 * deciding whether to think twice again. Absent when the entry carried none —
 * never an empty quote standing in for a failure nobody recorded.
 */
export function requeuedWords(
  r: NonNullable<BacklogItem["requeued"]>,
  status: BacklogStatus,
  now: number,
): string {
  const ago = sinceWords(now - r.at);
  const head = r.by === "run"
    ? `started again ${ago}`
    : `put back in the queue ${r.by === "assess" ? "by the assessment" : "from the phone"} ${ago}`;
  // `> 1` over an OPTIONAL number: `undefined > 1` is false, which is the right
  // answer, but the comparison is written against `r.n != null` as well so the
  // intent survives the next person reading it — absent is not "once", it is
  // "the host cannot say", and the two happen to render the same.
  const nth = r.n != null && r.n > 1 ? ` (${nthTime(r.n)} time)` : "";
  const before = r.error ? ` · failed before: “${r.error}”` : "";
  if (status === "failed") return `failed again — it was ${head}${nth}${before}`;
  if (status === "done") return `ran after being ${head}${nth}${before}`;
  return `${head}${nth}${before}`;
}
/**
 * `4m ago`, the spelling every other age on this row uses.
 *
 * It is `format.ts`'s `ago` arithmetic and deliberately not `ago` itself: that
 * one reads `Date.now()`, and this module takes `now` as an argument so
 * `node --test` can pin a sentence at a fixed instant. Not `fmtSpan` either —
 * that answers "how long did it TAKE" and prints `4m 0s`, which is right beside
 * a duration and wrong beside the row's own `added 3d ago`.
 */
function sinceWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

/** 2 → `2nd`. Only ever read for n > 1, and English's three irregulars are the
 *  whole of the rule worth writing down. */
function nthTime(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
