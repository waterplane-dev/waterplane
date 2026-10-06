/**
 * Part of `assessRows.ts`, the barrel every caller imports — after an apply: the backlog route, the receipt, new-item and pad-note words, the filed split.
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off the source.
 * Map of the slices: docs/notes/assess-architecture.md.
 */
import type { AssessRun } from "@waterplane/shared";
import { UNPICK_TITLE } from "./arowsAccept.ts";

/**
 * **The rows an apply left waiting, as ids — the route out of this sheet.**
 *
 * Applying used to be the end of the screen: the retirements were written, the
 * order was written, the new items were posted, and the sheet then said what it
 * had done and offered nothing. *"still no button to lead to the groomed
 * backlog with the results where I then can kick implementation off"* — there
 * was no route from the decision to the list the decision was about.
 *
 * **A count on a control is a filter**, so the number on that route and the cut
 * it opens are this one function, never two counts that have to agree. It
 * returns the IDS; `n` is their length, and the label takes that.
 *
 * ── The cut is THE GROOMED BACKLOG, not this run's share of it ──────────────
 *
 * It was the run's share once — rows stamped `assessOrigin(runId)` by the apply,
 * plus this run's `wanted` rows still waiting — and the button then said *"4
 * waiting in myapp"* over a repo with seven waiting, because a `queued` row the
 * run judged `unclear` is excluded by construction (it is queued, and it was
 * never `wanted`) and so is every retire-verdict row the person did not tick.
 * `assessOpenBacklogNote(0)` went further and said *"nothing here is waiting any
 * more"* while rows waited. A count that means something other than what it says
 * is the one failure this file exists to not have.
 *
 * So the cut is **every non-archived `queued`/`blocked` row in the repo**. That
 * IS the groomed backlog, which is what was asked for — *"the groomed backlog
 * with the results where I then can kick implementation off"* — the number then
 * means exactly the words on the button, and `origin`/`wanted` go away entirely
 * rather than being reworded.
 *
 * It reads the LIVE list, never the ticks, and that half is unchanged and still
 * load-bearing: `assessPicks.ts`'s `dropPicks` runs ON APPLY (ticks that have
 * become facts must not be re-offered as decisions) and a reload drops them
 * anyway, so a route derived from them would say 4 before a reload and 0 after
 * it about the same backlog.
 *
 * `queued` and `blocked` only. A row that has started is not waiting for
 * anybody, and a control that counted it would say "5 waiting" about four —
 * this file's rule that a number degrades to a smaller true one rather than to
 * a confident wrong one. Archived rows are out for the same reason: the tap
 * that archives a row is somebody saying it is not waiting.
 *
 * **Gated on `run.applied` here as well as at the call site**, because "the
 * route appears once the apply has happened" is a rule about this screen and a
 * rule in a component is a rule with no test.
 *
 * Order is the LIVE list's, because that is the order the backlog draws and the
 * order the cut will appear in.
 */
export interface AssessReadyRow {
  id: string;
  /** `BacklogItem.status` — read as a string so this module needs no lifecycle
   *  type. It is the BACKLOG's list and not the intent list on purpose: the ids
   *  have to be ids the Backlog sheet can filter to, and an intent that is a
   *  build or a schedule is not a row waiting in anybody's backlog. */
  status?: string;
  /** Set aside by hand. Not waiting for anything. */
  archived?: boolean;
}

/**
 * The states that mean "this has not started and nothing has ended it".
 *
 * `BacklogStatus` is `queued | running | done | failed` and the host's
 * `intentToBacklogItem` flattens a BLOCKED intent to `queued` — a block is a
 * sentence on the row, not a state, because such a row still starts once its
 * rung clears. `blocked` is kept in the set anyway: it is what the host's own
 * `waiting()` tests for, `status` is read as a plain string here, and a set
 * that accepts both cannot come apart from it.
 */
const WAITING = new Set(["queued", "blocked"]);

export function assessReadyCut(run: AssessRun | null, live: readonly AssessReadyRow[]): { ids: string[]; n: number } {
  if (!run?.applied) return { ids: [], n: 0 };
  const ids: string[] = [];
  for (const row of live) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    if (row.archived) continue;
    if (!WAITING.has(row.status ?? "")) continue;
    ids.push(row.id);
  }
  return { ids, n: ids.length };
}

/**
 * **The route's own words** — where it goes, and what is there.
 *
 * `open the backlog` on its own is a place; the count is what makes it an
 * answer to "what did I just do". It is now the repo's whole waiting list, so
 * *N waiting in myapp* is literally the number waiting in myapp.
 *
 * With NOTHING waiting the count is dropped rather than printed as a zero: `0
 * waiting` reads as a claim about the apply rather than about the repo. A number
 * that reads as the wrong claim is not drawn — the route still is, because the
 * list is still the place to look.
 */
export function assessOpenBacklogLabel(n: number, repoName: string): string {
  return n > 0 ? `open the backlog — ${n} waiting in ${repoName}` : `open the backlog in ${repoName}`;
}

/**
 * The sentence under the route. It says the two things the tap does NOT do —
 * this is a route and not a second mutation, and the apply has already happened
 * — plus what the filtered list will be.
 *
 * The zero case says what is true of the REPO and not of the run: nothing is
 * waiting there at all. It used to say "nothing here is waiting any more" while
 * `unclear` rows waited, which is the defect the cut was widened to fix.
 */
export function assessOpenBacklogNote(n: number): string {
  return n > 0
    ? `Opens exactly those ${n} — everything waiting in this repo, filtered, with the clear button on the bar. Nothing else is applied by this — the apply above already happened.`
    : "Nothing is waiting in this repo, so the list opens unfiltered. Nothing else is applied by this.";
}

/**
 * What the Backlog's filter bar calls this cut. That bar's whole job is to say
 * what the reader is looking at, and `made from these` — its default — says
 * nothing at all.
 *
 * So it names BOTH halves: what the cut is (everything waiting in this repo,
 * which is what the button counted) and where the reader came from (the
 * assessment). Naming only the assessment would have been the old cut's label
 * on the new cut — a bar reading *from the assessment of myapp* over rows the
 * assessment never judged.
 */
export function assessCutLabel(repoName: string): string {
  return `everything waiting in ${repoName}, from the assessment`;
}

/**
 * **What an apply that already happened did**, on the settled run's own row.
 *
 * It was a literal in `AssessSheet.tsx` — `applied: {n} retired · {n} ranked ·
 * {n} posted` — written when three counts were all there were. `AssessRun.
 * applied.requeued` is a fourth, and a receipt that silently drops it reports a
 * run whose entire effect was to revive nineteen rows as having re-sorted
 * nothing. So it moves here beside `assessApplyLabel`, which words the same
 * decision one beat earlier: the button that promises and the row that reports
 * are pinned by one test and cannot come apart.
 *
 * A zero `put back` is OMITTED rather than printed, `assessApplyLabel`'s rule:
 * `0 put back` reads as a claim that something was decided about putting rows
 * back. The other three keep their zeros, because they always have — this is a
 * record of a tap, and "0 retired" there is a fact about that tap.
 *
 * Past tense throughout, and it is the one place on this screen where past
 * tense is right: this apply has happened.
 */
export function assessAppliedWords(applied: NonNullable<AssessRun["applied"]>): string {
  const parts = [`${applied.dismissed} retired`, `${applied.ranked} ranked`];
  if (applied.requeued) parts.push(`${applied.requeued} put back`);
  // `named` is optional and a zero is OMITTED, `requeued`'s rule and its
  // reason: `0 titled` reads as a claim that somebody decided about titles,
  // where the truth is usually that the run wrote none or the switch said no.
  if (applied.named) parts.push(`${applied.named} titled`);
  parts.push(`${applied.posted} posted`);
  return `applied: ${parts.join(" · ")}`;
}

/**
 * **A new item is the one thing on this screen that ADDS work**, so it gets its
 * own verb rather than sharing `accept` with the verdicts.
 *
 * `post it` and `will be posted` say where it goes; what a person then wants to
 * know — and what "accept" hid — is that posting is still not running:
 * `assessNewItemNote` says the row lands in the backlog and opens its own
 * session when it fires, which is `Backlog.tsx`'s own sentence about every item
 * in that list.
 */
export const NEW_ITEM_WORDS = {
  label: "post it",
  picked: "will be posted",
  title: "add this to the backlog when you Apply — it is not started by this",
  pickedTitle: "tap to change your mind",
} as const;

export function assessNewItemNote(repoName: string): string {
  return `becomes a backlog item in ${repoName}, in its own session when it fires`;
}

/**
 * **The same card, when the words on it are the PERSON's.**
 *
 * An offer (`AssessNew.fromNote`) is a pad note the run said is still wanted,
 * copied verbatim by `cleanAssessment`. It ticks through `choices.news` exactly
 * like a proposed new item, and it must not READ like one: `post it` over
 * somebody's own sentence claims the run wrote it, and the two cards standing
 * side by side with one set of words on each is precisely the moment a person
 * has to be able to tell whose is whose.
 *
 * So the verb is `file it` — the pad's own word for this (`PadSheet`'s third
 * action does the same thing one note at a time) — and the ticked state is
 * `will be filed`, future tense like every other label here, because `Apply` is
 * still the only thing that acts.
 */
export const NOTE_ITEM_WORDS = {
  label: "file it",
  picked: "will be filed",
  title: "file your own words as a backlog item when you Apply, and take the note off the pad — nothing is started by this",
  pickedTitle: UNPICK_TITLE,
} as const;

/**
 * **What filing an offer does, including the half only this phone can do.**
 *
 * The host posts the row; it never reads or writes the pad, which is synced
 * client state. Clearing the note is the phone's job and it happens on the
 * RECEIPT — so the promise is worded as a sequence ("once the desktop has it"),
 * not as a simultaneity. If the link dies in between, the row exists and the
 * note stays: two copies, both visible, and one tap on the pad clears it. That
 * is a duplicate a person can see and fix, which is the direction this app errs
 * in; the sentence must not promise the other one.
 */
export function assessNoteItemNote(repoName: string): string {
  return `your note, word for word, becomes a backlog item in ${repoName} — and comes off the pad once the desktop has it`;
}

/**
 * **The receipt for the half the phone did.**
 *
 * Said only after `op.ack` came back `ok` and `removePadNotes` has run, because
 * it is a claim about the pad being shorter than it was. Singular and plural
 * are worded apart rather than `N note(s)`: this is the sentence that tells
 * somebody their own words moved, and a count they have to parse is a worse
 * receipt than a sentence they can read.
 */
export function assessNotesFiledWords(n: number): string {
  return n === 1
    ? "your note is on the backlog and off the pad"
    : `${n} notes are on the backlog and off the pad`;
}

/** Which of the ticked notes may come off the pad, and which may not. */
export interface AssessFiled {
  /** The desktop PROVED it posted these: they come off the pad. */
  clear: string[];
  /** It did not: they stay, where they can still be read and re-filed. */
  stay: string[];
  /** It was able to say at all. `false` ⇒ a host one version behind, and
   *  nothing is cleared on the strength of a count. */
  told: boolean;
}

/**
 * **Clear a filed note only on PROOF that it was filed.**
 *
 * An apply that the host answers `ok` is not an apply that posted every row it
 * was handed: `intents.post` refuses at the pending cap and on a draft it
 * cannot run, the loop carries on, and the receipt still says `ok` with only
 * counts on it. Three ticked offers against a full queue were therefore three
 * notes tombstoned — a tombstone TRAVELS — against no backlog row anywhere.
 * Which is a delete of somebody's own words, done on the strength of a message
 * that said nothing about them.
 *
 * So the ack carries `filed`: the `fromNote` ids that actually posted, and the
 * pad loses exactly `ticked ∩ filed`. The two failure directions are not
 * symmetric and the asymmetry is the whole rule — a note left on the pad
 * against a row that exists is a duplicate a person can see and clear in one
 * tap, while a note cleared against a row that does not exist is words nobody
 * can get back. Hence `told`: an older desktop that cannot answer at all
 * clears NOTHING, and the sentence says so rather than guessing from the count.
 */
export function assessFiledSplit(ticked: readonly string[], filed: readonly string[] | undefined): AssessFiled {
  const told = Array.isArray(filed);
  if (!told) return { clear: [], stay: [...ticked], told: false };
  const landed = new Set(filed);
  const clear: string[] = [];
  const stay: string[] = [];
  for (const id of ticked) (landed.has(id) ? clear : stay).push(id);
  return { clear, stay, told: true };
}

/**
 * The receipt for that split, in one sentence — or `null` when there is nothing
 * to say (nothing was ticked).
 *
 * One function for all four outcomes, because the difference between them is
 * exactly what the person needs to hear and three call sites wording it would
 * be three chances to say "filed" about a note still sitting on the pad. Every
 * one of them names where the words ARE, which is the only fact that matters
 * on a screen somebody is about to leave.
 */
export function assessFiledWords(split: AssessFiled): string | null {
  const k = split.clear.length;
  const s = split.stay.length;
  if (!k && !s) return null;
  if (!split.told) {
    // Never worded as a failure. The rows may well exist — an apply replayed
    // under a fresh ackId is answered off the host's ledger, which knows the
    // apply happened and genuinely cannot say which notes the first one filed.
    // What is TRUE of every such ack is that the words are still on the pad.
    // Short on purpose: measured at 320×780 with `--ui-font` forced to 1.9, the
    // longer version ran to twelve lines of toast over the sheet it is about.
    // Where the words ARE is the fact; the pad's own trash is the next step and
    // it is one tap away on the screen this sentence is standing on.
    return s === 1
      ? "your note is left on the pad — the desktop could not say whether it filed it"
      : `your ${s} notes are left on the pad — the desktop could not say which it filed`;
  }
  if (!s) return assessNotesFiledWords(k);
  if (!k) {
    return s === 1
      ? "nothing was filed — your note is still on the pad"
      : `nothing was filed — your ${s} notes are still on the pad`;
  }
  const filed = k === 1 ? "1 note is on the backlog and off the pad" : `${k} notes are on the backlog and off the pad`;
  const left = s === 1 ? "1 is still on your pad — the desktop did not file it" : `${s} are still on your pad — the desktop did not file them`;
  return `${filed}; ${left}`;
}
