/**
 * How much every repo's transport directories hold — the reading the per-repo
 * sweep cannot give you.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * `SweepSheet` is reached from ONE repo's gallery, so using it means already
 * knowing which repo is fat. Measured here: 7.5 GB across fourteen repos, with
 * 4.5 GB in one and 2.5 GB in a second and a long tail of tens of megabytes.
 * Finding that by hand is fourteen trips through a sheet that answers one repo
 * at a time.
 *
 * ── It walks nothing of its own ─────────────────────────────────────────────
 *
 * Every row comes from `listTransport` — the SAME function the per-repo sweep's
 * GET serves its rows from. That is not a convenience: the survey's number and
 * the total the sweep opens to must be one function, or the row says 38 files
 * and the sheet it opens shows 39, and a person learns to distrust both. The
 * only thing this module adds is the loop, the ranking (in `@waterplane/shared`, so
 * the phone cannot re-derive it differently) and the bound below.
 *
 * ── The bound, and why there is one at all ──────────────────────────────────
 *
 * `listTransport` is synchronous `readdir` + `lstat`, and this runs on the loop
 * that pumps every PTY in the house. The measured worst case is a 523-file
 * inbox and fourteen repos, i.e. single-digit milliseconds — so the bound is
 * not about today's numbers. It is about the fact that nothing stops a repo
 * from holding a hundred thousand files, and that a phone can ask for this
 * whenever it likes.
 *
 * Two things follow, and both matter:
 *
 *  - **Past the budget, that repo's tally is `null`, never a partial count.**
 *    A truncated count printed as a total is exactly the wrong number CLAUDE.md
 *    forbids — and it is worse here than usual, because the number's whole job
 *    is to tell you which repo to go and delete things in.
 *  - **A yield between repos.** `await setImmediate` hands the loop back so a
 *    survey of a pathological tree cannot stall a keystroke on its way to a
 *    session.
 *
 * Nothing is cached. The walk is cheaper than a stale answer would be worth,
 * and a cached byte total on a screen about deleting is the reading most likely
 * to be acted on and least likely to be true.
 *
 * **Nothing applies itself**: this measures. It deletes nothing, schedules
 * nothing, and there is no "sweep every repo" anywhere above it — a person
 * taps a row and lands in the per-repo sweep, where they still pick a cut and
 * still confirm.
 *
 * `packages/host/test/transportsurvey.test.mjs`.
 */
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { summarizeSurvey, tally, type TransportSurvey, type TransportSurveyRow } from "@waterplane/shared";
import { listTransport } from "./files.js";
import { discoverTargets } from "./repos.js";

/**
 * Entries one repo's two directories may hold before the survey gives up on
 * counting it.
 *
 * Not a knob (no env var, nothing in `.env.example`): a survey that counts a
 * different amount on two desktops is a survey whose "not counted" row means
 * something different in every bug report. 50 000 is two orders of magnitude
 * above the worst directory measured here, and the shape of `builds.ts`'
 * `detectArtifacts` budget.
 */
const ENTRY_BUDGET = 50_000;

/** One scope of one repo, or null when it went past the budget or could not be
 *  read. The two failures collapse deliberately — from the phone they are the
 *  same fact ("this screen does not know"), and telling them apart would need a
 *  sentence per row that nobody can act on differently. */
function scopeTally(worktree: string, scope: "outbox" | "inbox") {
  try {
    const rows = listTransport(worktree, scope);
    if (rows.length > ENTRY_BUDGET) return null;
    return tally(rows);
  } catch {
    return null;
  }
}

/**
 * Every discovered worktree, ranked by what its transport directories hold.
 *
 * `discoverTargets` is the same enumeration the launcher uses, so a repo that
 * can be opened is a repo that appears here — and one that cannot, does not.
 * Its cost (a `git worktree list` per repo) is one the phone already pays on
 * every launcher open.
 */
export async function surveyTransport(root: string, now = Date.now()): Promise<TransportSurvey> {
  const targets = await discoverTargets(root);
  const rows: TransportSurveyRow[] = [];
  for (const t of targets) {
    rows.push({
      repoId: t.id,
      repoName: t.repoName,
      branch: t.branch,
      isPrimary: t.isPrimary,
      outbox: scopeTally(t.worktreePath, "outbox"),
      inbox: scopeTally(t.worktreePath, "inbox"),
    });
    // Between repos, not inside one: `listTransport` is synchronous and
    // splitting it would mean a directory measured across two instants.
    await yieldToLoop();
  }
  const { repos, total, partial } = summarizeSurvey(rows);
  return { at: now, repos, total, partial };
}
