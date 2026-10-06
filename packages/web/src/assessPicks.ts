/**
 * The ticks somebody has made on an assessment, kept alive while they look at
 * something else.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `App` returns early once per overlay (`overlayViews` — the rule is in the
 * `web` skill and in `App.tsx`'s own comment), so the assessment sheet is
 * UNMOUNTED, not covered, the moment anything else opens: the plan document, an
 * item, a picture named by one of the prompts. Every tick made so far went with
 * it. That is a delete of typed intent in the same sense `seedSheetDraft` is —
 * the marks are decisions a person made with sixty verdicts in front of them,
 * and the whole point of the thumbnail on a row is that you can go and LOOK at
 * the screenshot the item is about before deciding. A screen that punishes
 * looking is a screen that teaches tapping through, which is the failure this
 * change exists to fix.
 *
 * So the picks live outside the component, in this module, for as long as the
 * tab does.
 *
 * ── Why it is not persisted ────────────────────────────────────────────────
 *
 * Deliberately no `localStorage`, no IndexedDB, nothing on disk — and so no
 * storage key, which is also what `local/no-storage-key-literal` and
 * `storage.ts` require of any file but `storage.ts` itself. An approval is
 * formed against verdicts that were on the screen at the time; a reload is
 * where the proposal is re-read, and re-arriving with yesterday's ticks
 * pre-made would be the app answering a question on the user's behalf. The
 * failure this guards against is a glance at a picture, not a power cut.
 *
 * ── Why it is keyed on the run ─────────────────────────────────────────────
 *
 * The sheet's existing rule — a new run is a new proposal. Verdicts are
 * re-formed from scratch by every run, and an id ticked under one run's
 * reasoning says nothing about what the next run concluded about it. So picks
 * are filed under `runId`: a run nobody has ticked anything on comes back
 * empty, and there is no path by which one run's approvals are applied to
 * another's proposal.
 *
 * ── The copy rule ──────────────────────────────────────────────────────────
 *
 * Everything in and out is COPIED. React state is replaced, not mutated, but a
 * store that handed back the array it holds would let one stray `push` in a
 * component change what a later read believes was approved — an aliasing bug
 * whose symptom is an apply that retires a row nobody ticked. There is no
 * version of that which is worth the allocation saved.
 *
 *     node --test packages/web/src/assessPicks.test.mjs
 */

/**
 * One run's answers.
 *
 * `rejected` is beside `rows` rather than derived from it because "I read this
 * and left it alone" and "I have not got to this yet" are different states, and
 * only the person can tell them apart — a strip that cannot show which is which
 * cannot say how much is left to decide.
 */
export interface AssessPicks {
  /** Row ids ticked. */
  rows: string[];
  /** Merge group ids approved — one decision about all N members. */
  merges: string[];
  /** Indices into `proposal.news`. */
  news: number[];
  /** Row ids explicitly left alone (`LEAVE_WORDS`), which is an answer too. */
  rejected: string[];
  /** The answer to `assessPinQuestion`, carried so it survives the same glance. */
  pinRanks: boolean;
  /**
   * …and the answer to `assessNameQuestion`, carried for the same reason.
   *
   * It is a decision about THIS proposal's titles, made with them on screen, so
   * it belongs to the run exactly as the ticks do — and losing it to a glance
   * at a picture would be the same delete, one field along.
   */
  writeNames: boolean;
}

/**
 * Per tab, per run, in memory. Not bounded: an entry is four small arrays, a
 * tab sees a handful of runs in its life, and any eviction rule here would be a
 * rule that can silently throw away ticks — which is the one thing this module
 * is for not doing.
 */
const byRun = new Map<string, AssessPicks>();

const copy = (p: AssessPicks): AssessPicks => ({
  rows: [...p.rows],
  merges: [...p.merges],
  news: [...p.news],
  rejected: [...p.rejected],
  pinRanks: p.pinRanks === true,
  writeNames: p.writeNames === true,
});

/** What was ticked on this run, or `null` if nothing has been. `null` rather
 *  than an empty set so the caller can tell "not started" from "everything
 *  un-ticked" without a second field. */
export function loadPicks(runId: string): AssessPicks | null {
  if (!runId) return null;
  const hit = byRun.get(runId);
  return hit ? copy(hit) : null;
}

export function savePicks(runId: string, picks: AssessPicks): void {
  if (!runId) return;
  byRun.set(runId, copy(picks));
}

/** Forget this run's ticks — after an apply, when they have become facts about
 *  the backlog and re-offering them would be offering a decision twice. */
export function dropPicks(runId: string): void {
  byRun.delete(runId);
}
