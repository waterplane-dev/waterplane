/**
 * The assessment proposal, arranged for a person who has to disagree with it.
 *
 * ── Why this is a separate file ────────────────────────────────────────────
 *
 * `AssessSheet` renders a diff whose "accept" retires words somebody wrote.
 * Every question that decides whether a tap is safe — which verdict a row is
 * under, whether accepting it does anything at all, which words it is about,
 * what a bulk confirmation puts in front of the user before it fires — is a
 * RULE, and a rule inside a component is a rule that can only be checked by
 * looking at a phone. This is `activityRows.ts`'s split for `activityRows.ts`'s
 * reason: the selector is pinned by `node --test` in milliseconds, and the sheet
 * below it is allowed to be nothing but markup.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 *
 * It writes no sentence that `@waterplane/shared`'s `assess.ts` already writes.
 * `assessVerdictLabel`, `assessRowSentence` and `downgradeText` are the host's
 * words too, and `clihealth.ts` states the rule this file obeys: the phone's row
 * and the host's stored reason must not word one fact two ways, or "already
 * done" and "done" become two categories in a list somebody is scanning for the
 * one row they disagree with. What is composed here is only what the shared
 * module has no opinion about — the ORDER of the strips, which rows a bulk
 * button would cover, and the refusal sentences for taps that would do nothing.
 *
 * It also does not decide anything. `applyAssessment` in `@waterplane/shared` turns
 * approvals into mutations and the host performs them; this only says which
 * approvals a person is able to give.
 *
 * ── Two rules about the words on the controls ──────────────────────────────
 *
 * **A verb that does nothing is not drawn, and the reason is TEXT.** Where a
 * tap would be swallowed there is no button at all and the row says why —
 * `Unavailable.tsx`'s rule, for its reason: a `title` is invisible on a phone
 * and a greyed control reads as "not yet" when the truth is "never here". Every
 * such sentence is `assessAcceptBlocker`'s, so the strip, the row and the bulk
 * button cannot come to disagree about which taps mean something.
 *
 * **Every ticked label is FUTURE tense** — `will be retired`, never `retired` —
 * because `Apply`, at the bottom, is the only thing on this screen that acts. A
 * tick is an opinion held for as long as it takes to read the next row; past
 * tense on one is the app claiming a thing has happened that has not. This
 * screen's whole failure mode is somebody approving what they did not
 * understand, and a label that says the work is done is that failure written
 * out.
 *
 * ── A pad note is judged and left — and, when it is still WANTED, offered ──
 *
 * The other half of that rule, which used to be the whole of it. This app never
 * edits the pad, so no verdict on a note is applicable and `assessAcceptBlocker`
 * refuses every one of them. That left `still wanted` on a note saying nothing
 * could be done about the one verdict that means the words are worth doing.
 *
 * `cleanAssessment` closes it on the shared side: a `wanted` note becomes an
 * OFFER in `proposal.news`, carrying the note's own text verbatim (copied there
 * by the module, not by the CLI — that is why "verbatim" is a guarantee and not
 * a hope) and its id in `AssessNew.fromNote`. So the note's refusal on the row
 * is no longer "nothing to do here": it says where the offer is, in
 * `assessAcceptBlocker`'s `wanted` branch. The offer is ticked like any other
 * new item, `NOTE_ITEM_WORDS` words it as the person's own words rather than
 * the run's, and `assessNoteItemNote` promises the half only the PHONE can
 * keep — the note comes off the pad, on the receipt, never on the tick.
 *
 * ── The one rule that is not negotiable ────────────────────────────────────
 *
 * `AssessDisplayRow.text` and `AssessMergeCard.prompt`/`originals[].text` are
 * the words, in FULL, never clipped. The only strings shortened anywhere in
 * this file are the SAMPLES inside a confirmation dialog, which is a label on a
 * button and not the row. A person approving a merge is approving text they did
 * not write in place of text they did, and the only defence is both, whole, at
 * the moment of the tap.
 *
 *     node --test packages/web/src/assessRows.test.mjs
 *
 * ── This file is the BARREL ────────────────────────────────────────────────
 *
 * The rules live in `assess/`, one file per subject, and every caller keeps
 * importing `./assessRows` (the test imports `./assessRows.ts`, and must pass
 * untouched). `arows` prefix: basenames are unique across `packages/`, and
 * `assess.ts` is the host's and shared's. What each file holds
 * (docs/notes/assess-architecture.md):
 *
 *   arowsDisplay.ts   `AssessDisplayRow`, the retiring verdicts, the sample size
 *   arowsAccept.ts    what a tap does or refuses: accept blockers and words,
 *                     the position sentence, where a put-back row runs
 *   arowsGroups.ts    the strips and merge cards, `assessGroups`, `assessRowHead`
 *   arowsBulk.ts      the unclear tally, bulk and merge confirmation words
 *   arowsApply.ts     the guide, ticks counted, `assessApplySummary`/`Label`/`Note`
 *   arowsAfter.ts     after an apply: the backlog route, the receipt, new-item
 *                     and pad-note words, the filed split
 *   arowsRun.ts       why apply or run cannot be pressed, and `assessWatch`
 *
 * `arowsAccept.ts` is exported by NAME: its `UNPICK_TITLE` is shared with
 * `arowsAfter.ts` and is not part of this module's surface.
 * `tools/assesspins.test.mjs` pins the export list.
 */
export * from "./assess/arowsDisplay.ts";
export {
  assessMissingWords, ASSESS_MISSING_BLOCKED, ASSESS_NOTE_OFFERED, assessAcceptBlocker, assessRowPosition,
  requeueWhereWords, assessAcceptWords,
  type AssessAcceptWords,
} from "./assess/arowsAccept.ts";
export * from "./assess/arowsGroups.ts";
export * from "./assess/arowsBulk.ts";
export * from "./assess/arowsApply.ts";
export * from "./assess/arowsAfter.ts";
export * from "./assess/arowsRun.ts";
