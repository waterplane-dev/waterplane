/**
 * What an assessment is ALLOWED to conclude.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * One button asks the CLI to read a whole repo and say, of everything still
 * open for it, what is already done, what is obsolete, what is covered by
 * something else, and what is still worth doing. The answer arrives as JSON the
 * CLI wrote about the user's own words — which is the most dangerous input this
 * app takes. A model that says "implemented" about something half-implemented
 * is the EXPECTED failure here, not a surprising one, and the cost of believing
 * it is a prompt somebody wrote and can no longer find.
 *
 * So the parse is not a parse. It is the place where a claim has to earn its
 * verdict:
 *
 *   • a retiring verdict with no citation is not a verdict — it is downgraded
 *     to `unclear`, which retires nothing;
 *   • a `superseded` pointing at itself, at an unknown id, or round a cycle is
 *     a graph a phone cannot audit — flattened to one hop, and anything worse
 *     downgraded;
 *   • a merge group — the one verdict that writes a prompt in place of the
 *     user's own — has to be 2..MAX_MERGE_SIZE ids, each belonging to exactly
 *     one group and to no other verdict, with a prompt that is actually there;
 *   • an item the assessment simply did not mention comes back as `unclear`
 *     rather than vanishing, because silence about a row is not a decision
 *     about it.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *
 * No filesystem, no `Date.now()`, no host imports — this is `intent.ts`'s
 * posture, for `intent.ts`'s reason: the whole rule set is then pinnable from
 * literals by `packages/shared/test/assess.test.mjs` in milliseconds, with no
 * daemon booted and nothing spawned, which is what lets the rules be settled
 * before there is anything that can run them.
 *
 * Nothing here APPLIES anything either. `applyAssessment` decides the
 * mutations; the host performs them. That split is what makes "nothing applies
 * itself" checkable rather than a promise: a proposal with no approvals decides
 * nothing, and there is exactly one function that turns approvals into work.
 *
 * ── The one rule that is not negotiable ────────────────────────────────────
 *
 * Nothing here loses a prompt. Every cap below is on a COUNT, on a citation, or
 * on a label — never on `AssessItem.text`, which is the user's own words and is
 * passed through untouched. The two pieces of prose the CLI itself writes (a
 * merge prompt, a new item) are not clipped either: past `MAX_PROMPT_CHARS`
 * they are DROPPED with a note, because half an instruction that runs is worse
 * than an instruction that never ran.
 */

export { ASSESS_VERDICTS, CITING_VERDICTS, MIN_MERGE_SIZE, MAX_MERGE_SIZE, MAX_MERGE_GROUPS, MAX_NEW, MAX_EVIDENCE_CHARS, MAX_RATIONALE_CHARS, MAX_PROMPT_CHARS, MAX_RANK, MAX_ASSESS_NOTES, ASSESS_IN_FILE, ASSESS_OUT_FILE, ASSESS_PLAN_FILE } from "./assess/sassvocab.js";
export type { AssessSource, AssessVerdict } from "./assess/sassvocab.js";
export type { AssessItem, AssessNote, AssessInput, AssessDowngrade, AssessRow, AssessMerge, AssessNew, AssessProposal } from "./assess/sassio.js";
export { cleanAssessment } from "./assess/sassclean.js";
export { assessVerdictLabel, downgradeText, assessRowSentence, assessDismissReason, assessCounts, assessNameCount, assessPinQuestion, ASSESS_PIN_KEEP, ASSESS_PIN_FREE, assessPinNote, assessNameQuestion, ASSESS_NAME_WRITE, ASSESS_NAME_SKIP, assessNameNote } from "./assess/sasswords.js";
export type { AssessChoices } from "./assess/sasswords.js";
export { assessOrigin, applyAssessment } from "./assess/sassapply.js";
export type { AssessApplyContext, AssessDismiss, AssessRank, AssessPost, AssessName, AssessMutations } from "./assess/sassapply.js";
