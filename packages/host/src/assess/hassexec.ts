/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AssessNote, Intent, IntentDraft, ItemName } from "@waterplane/shared";
import { ASSESS_PLAN_FILE } from "@waterplane/shared";
import type { ExecutorResult } from "../intents/manager.js";
import { AssessStore } from "./hassstore.js";
import { runAssessment } from "./hassrun.js";
import { ASSESSABLE_STATES } from "./hassknobs.js";

// ── The executor ─────────────────────────────────────────────────────────────

/**
 * Everything the executor needs from the rest of the host, as functions.
 *
 * `IntentDeps`' posture: asking is cheaper than being told, and it removes any
 * chance of a run acting on a snapshot somebody forgot to refresh — which for
 * this run would mean assessing a list of items that has moved on.
 */
export interface AssessDeps {
  store: AssessStore;
  /** Every intent the host holds (the builder filters by `cwd`). */
  intents(): readonly Intent[];
  /** The pad notes carrying this `cwd` — the other store "everything left" means. */
  notes(cwd: string): readonly AssessNote[];
}

/**
 * The intent executor, ready to plug in.
 *
 * The run is an Intent with `target: {kind:"shell"}`, which is `builds.ts`'
 * shape and gets, for free, the four properties that matter: it is on disk
 * before the tap returns, it is visible in Activity while it works, it is
 * budget-gated like every other unattended run, and it is at-most-once by
 * intent id across a restart.
 *
 * It resolves when the process does, so it sets no `watch`: unlike a delivery
 * into a session, there is no turn afterwards to wait for. A failed run is
 * `ok: false` and never `retry` — a second full read of a repo is real money,
 * and nothing here was half-typed into anything.
 */
export function makeAssessExecutor(deps: AssessDeps): (i: Intent) => Promise<ExecutorResult> {
  return async (i: Intent): Promise<ExecutorResult> => {
    const startedAt = Date.now();
    // The scope is recorded on the run at START, not derived from `input` when
    // it ends: `input` does not exist for the twenty minutes the run takes, and
    // that is exactly the window somebody is watching it in to see whether it
    // is doing what they asked.
    const scopedIds = i.payload.kind === "assess" && i.payload.ids?.length ? i.payload.ids : undefined;
    deps.store.set(i.id, { runId: i.id, repoDir: i.cwd, status: "running", startedAt, scopedIds });
    try {
      // Watched: what it is doing goes to memory and the socket as it happens
      // (`setLive`), and the last reading is persisted below with the settled
      // run. Nothing on it is read by anything that decides.
      const res = await runAssessment(
        i.cwd, deps.intents(), deps.notes(i.cwd), startedAt, scopedIds,
        (p) => deps.store.setLive(i.id, { progress: p }),
      );
      const assessable = res.input.items.filter((x) => !x.context).length;
      deps.store.set(i.id, {
        status: res.ok ? "done" : "failed",
        finishedAt: Date.now(),
        detail: res.detail,
        envelope: res.envelope,
        itemCount: res.input.items.length,
        assessableCount: assessable,
        // The words the verdicts were formed against, kept ON the run. See
        // `AssessRun.input`: the proposal carries ids and no prose, and
        // re-deriving the prose from current state renders today's words under
        // yesterday's verdict.
        input: res.input,
        proposal: res.proposal,
        planPath: res.planWritten ? ASSESS_PLAN_FILE : undefined,
        // The plan's VERSION, beside its path: every run rewrites the same
        // path, and the reader's document cache is keyed on (repo, path,
        // mtime) — without this every run's plan files under one key and a
        // later run can show an earlier run's plan under this run's verdicts.
        planMtime: res.planMtime,
        // What it was seen doing, kept: the stream is gone by the time anybody
        // reads a surprising proposal and asks what it actually looked at.
        progress: res.progress,
      });
      return { ok: res.ok, detail: res.detail };
    } catch (err) {
      const detail = `the assessment could not run: ${String(err).slice(0, 200)}`;
      deps.store.set(i.id, { status: "failed", finishedAt: Date.now(), detail });
      return { ok: false, detail };
    }
  };
}

// ── Starting one ─────────────────────────────────────────────────────────────

/**
 * The slice of `IntentManager` this file needs, as an interface.
 *
 * `builds.ts` holds the manager itself; this holds seven methods, because that
 * is all starting a run and applying a proposal are allowed to do, and a narrow
 * type is the place that says so. Nothing here can delete a row: `remove()` is
 * deliberately not in it, and the one rule this whole feature rests on is that
 * an assessment retires words and never loses them. The seventh is `kick()`,
 * which mutates nothing at all — see its own note for why an apply has to be
 * able to say "now" exactly once.
 */
export interface AssessIntents {
  get(id: string): Intent | undefined;
  post(draft: IntentDraft): { ok: boolean; intent?: Intent; reason?: string };
  cancel(id: string, reason?: string): boolean;
  dismiss(id: string): boolean;
  /** `handOrdered` is the host's own field (a client cannot set it) and marks a
   *  position a PERSON decided — a drag, or an assessment ranking they approved.
   *  `smartpick.ts` widens the same slice for the same reason. */
  edit(id: string, patch: { order?: number; archived?: boolean; label?: string; handOrdered?: boolean }): { ok: boolean; refused?: string };
  /**
   * Put a FAILED row back in the queue — the `still wanted` half a rank cannot
   * express, and the one mutation this slice gained after it was written.
   *
   * ── What widening it to six methods does, and what it deliberately does not ─
   *
   * It makes a row that had STOPPED runnable again. That is a real change: until
   * now every verb here either retired work (`cancel`/`dismiss`) or moved it in
   * a list (`edit`), and nothing an assessment approved could put an agent back
   * on a task. It is the change the feature is, though — applying *still wanted*
   * to a failed row wrote a sort position into a queue the row was not in, and
   * on the desktop this was written on that was 19 of 19 rows.
   *
   * What it does NOT make reachable, which is the half worth naming: `remove`
   * is still absent, so nothing here can lose words; `markDone` is absent, so an
   * assessment cannot claim work happened; `runNow` is absent, so nothing here
   * spawns an agent — a re-queued row waits its turn like every other queued row
   * and the ladder decides; `update`/`retarget` are absent, so it cannot rewrite
   * what a row says or where it runs; and there is no un-archive.
   *
   * And it cannot revive a `done` or `canceled` row: that refusal lives in the
   * manager, but the NAME is the type saying so — this is `requeueFailed`, not
   * `requeue`, and the bare verb (which `backlog.ts` reaches with `allowDone`)
   * is not in this interface at all.
   */
  requeueFailed(id: string, by: { kind: "assess"; runId: string }, opts?: { kick?: false }): { ok: boolean; reason?: string };
  /**
   * Put the run's title and kind on a row — the eighth method, and the only one
   * that writes something a person READS rather than something the ladder acts
   * on.
   *
   * It widens the slice by nothing dangerous, which is the whole argument for
   * admitting it: `name()` cannot move a row, cannot run one, cannot retire one
   * and cannot overwrite a `hand` field. The worst thing an assessment can do
   * through it is put a wrong title on a row, which costs one tap to clear —
   * and the author it stamps (`assess`) is what makes that tap possible, since
   * a row that could not say who named it could not say whether the name may
   * be replaced.
   *
   * Handed `"assess"` at every call site here. The author is not on the wire
   * (`AssessName`'s note says why) and must not become an argument a caller
   * chooses.
   */
  name(id: string, n: ItemName, by: "assess"): { headline: boolean; category: boolean };
  /**
   * Ask the ladder to look at the list — ONCE, when the whole apply is written.
   *
   * It is in this slice for a reason that is nothing to do with what an
   * assessment may decide: every `requeueFailed` used to kick on its way out, a
   * kick runs a pass synchronously as far as its first `await`, and so applying
   * nineteen verdicts fired the FIRST revived row while eighteen re-queues and
   * the entire rank loop had still to happen. The pass saw one candidate, so
   * `smartpick.hold()` — which refuses to think about a list of one — returned
   * null, and the row went with neither the approved order nor the pick applied
   * to it. The person's ranking was written a moment after the only fire it was
   * supposed to govern.
   *
   * So the loop passes `kick: false` and this is called after the ranks. It
   * decides nothing and cannot: it is "look now", and what the ladder then does
   * is the ladder's.
   */
  kick(): void;
}

/**
 * Write the run down. One tap, one durable row, and no second scheduler.
 *
 * The refusal is here rather than in the route for the reason `builds.run()`
 * answers "unknown build" synchronously: every reason a run cannot start is
 * known now, while there is still a socket to be told on, and a run that got as
 * far as an executor before discovering it was the second one for this repo
 * would already have spent the agent.
 *
 * One at a time per repo is the rule that matters. Two assessments over one
 * list come back with different verdicts about the same rows, and reconciling
 * that is a merge nobody can do on a phone.
 */
export function startAssessment(
  intents: AssessIntents,
  store: AssessStore,
  repoDir: string,
  /** The cut the caller is asking about; absent is the whole repo. */
  ids?: readonly string[],
): { runId: string } | { error: string } {
  const busy = store.running(repoDir);
  if (busy) return { error: "an assessment is already running for this repo — two of them would propose different verdicts on one list" };
  /**
   * **A scope is checked HERE, while there is still a socket to refuse on.**
   *
   * `buildAssessInput` would simply find nothing and the run would spend a
   * whole agent reading a repo to answer a question about zero rows — and
   * `startAssessment`'s own doc says why every knowable refusal belongs at the
   * tap. The two ways a scope can be empty are worth telling apart on the
   * phone, but not here: both mean the same thing to this function, which is
   * that there is nothing to judge.
   *
   * It also does the containment: an id belonging to ANOTHER repo's row simply
   * is not in this repo's assessable set, so a scope made of them refuses
   * rather than quietly assessing the whole of a repo the caller never named a
   * row in. `buildAssessInput` filters on `cwd` too — this is the half that
   * turns that filter into a sentence instead of a surprise.
   */
  const scope = ids && ids.length
    ? ids.filter((id) => {
      const i = intents.get(id);
      return !!i && i.cwd === repoDir && i.payload.kind === "prompt" && ASSESSABLE_STATES.has(i.state);
    })
    : null;
  if (scope && !scope.length) {
    return {
      error: "nothing in that cut can be assessed — an assessment judges work that is still open, "
        + "and these rows are finished, running, or not this repo's",
    };
  }
  const runId = "as_" + randomUUID().slice(0, 8);
  const posted = intents.post({
    id: runId,
    cwd: repoDir,
    payload: scope ? { kind: "assess", ids: scope } : { kind: "assess" },
    // `builds.ts`' shape, and for its four properties: on disk before the tap
    // returns, visible while it works, budget-gated, at-most-once by intent id
    // across a restart.
    target: { kind: "shell" },
    trigger: { kind: "now" },
    title: `assess ${basename(repoDir)}`,
  });
  if (!posted.ok || !posted.intent) return { error: posted.reason || "could not be written down" };
  return { runId };
}