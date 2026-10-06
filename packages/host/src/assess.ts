/**
 * "Of the work still standing here, what is actually still worth doing?" — the
 * half of that question that touches the disk.
 *
 * ── The contract is a FILE, both directions ────────────────────────────────
 *
 * The obvious implementation pastes eighty-four prompts into a kickoff message
 * and parses the answer out of what comes back. Both halves of that are wrong
 * here. A multi-line write into a TUI is a paste, and `deliver.ts` documents at
 * length what the CLI then does to it; and an answer scraped out of prose is a
 * parser fighting a narrator. So the host writes `<state dir>/assess-in.json`, asks
 * for `<state dir>/assess-out.json` and `<state dir>/plan.md` back, and the kickoff prompt
 * is four paragraphs naming two paths and the rules. The items are never in the
 * prompt at all, which is also why the run is cheap enough to offer.
 *
 * The envelope is the completion signal and the error channel. It is never the
 * content. A run whose file is missing or unparseable FAILS and says which,
 * keeping the envelope text as the detail — because when the file is not there,
 * the envelope is the only thing left to debug from, and throwing it away
 * leaves a red row nobody can act on.
 *
 * The run is bought with `claude -p --output-format stream-json --verbose` so
 * it can be WATCHED (see `runClaude`), which moves the envelope but does not
 * change what it is: it is now the LAST line of the stream instead of the whole
 * of stdout, and `resultText` reads it in either shape. The FILE is still the
 * content either way — nothing on the stream is ever treated as an answer.
 *
 * ── Three things that are easy to get wrong ────────────────────────────────
 *
 *  • **The stale output file.** `<state dir>/assess-out.json` is deleted before the
 *    run. Without that, a run that writes nothing at all silently "succeeds"
 *    with the PREVIOUS run's verdicts — retiring rows on the strength of an
 *    assessment of a repo two days older. It is the same failure `settle.ts`
 *    guards with `spendTurn`: evidence that belongs to somebody else.
 *  • **A fresh session, deliberately.** `review.ts`'s runners prefer
 *    `--continue` so a check starts with warm context. An assessment must not:
 *    the conversation it would resume is the one that did the work it is being
 *    asked to grade, and its opinion of its own output is the one opinion this
 *    run cannot use.
 *  • **It has to be allowed to WRITE.** Every other headless runner in this
 *    daemon says "do not make any changes"; this one's entire deliverable is
 *    two files. Hence `--permission-mode acceptEdits`, and hence the prompt
 *    saying "change nothing else" in the same breath.
 *
 * Nothing here decides anything. The verdicts arrive through
 * `shared/assess.ts`'s `cleanAssessment`, which is where every rule that stops
 * a confident-sounding model from retiring real work lives, and which can be
 * pinned without spawning anything.
 */

export { ASSESS_TIMEOUT_MS, ASSESS_CONTEXT_MAX, ASSESS_MAX_RUNS, ASSESSABLE_STATES } from "./assess/hassknobs.js";
export { AssessStore } from "./assess/hassstore.js";
export { buildAssessInput, assessPrompt } from "./assess/hassinput.js";
export { ASSESS_TAIL_MAX, ASSESS_PROGRESS_MS, assessProgressInit, foldAssessEvent } from "./assess/hassprogress.js";
export { resultText } from "./assess/hassutil.js";
export { runAssessment } from "./assess/hassrun.js";
export type { AssessRunOutcome } from "./assess/hassrun.js";
export { makeAssessExecutor, startAssessment } from "./assess/hassexec.js";
export type { AssessDeps, AssessIntents } from "./assess/hassexec.js";
export { applyProposal } from "./assess/hassapply.js";
export type { AssessApplyOutcome } from "./assess/hassapply.js";
