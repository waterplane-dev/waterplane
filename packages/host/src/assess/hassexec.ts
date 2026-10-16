/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AssessNote, AssessPayload, Intent, IntentDraft, ItemName, SlotRow } from "@waterplane/shared";
import { ASSESS_PLAN_FILE, cleanAssessScope, findSlot, slotRowOfIntent } from "@waterplane/shared";
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
    // A slot scope only ever rides beside ids (`cleanIntentPayload`).
    const scope = i.payload.kind === "assess" && scopedIds ? i.payload.scope : undefined;
    deps.store.set(i.id, { runId: i.id, repoDir: i.cwd, status: "running", startedAt, scopedIds, ...(scope ? { scope } : {}) });
    try {
      // Watched: what it is doing goes to memory and the socket as it happens
      // (`setLive`), and the last reading is persisted below with the settled
      // run. Nothing on it is read by anything that decides.
      const res = await runAssessment(
        i.cwd, deps.intents(), deps.notes(i.cwd), startedAt, scopedIds,
        (p) => deps.store.setLive(i.id, { progress: p }),
        scope,
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
  /** Every row — read-only, and read only to re-derive a SLOT from the live
   *  rows (`startAssessment` with a slot scope; a merge's member clocks). */
  list(): readonly Intent[];
  post(draft: IntentDraft): { ok: boolean; intent?: Intent; reason?: string };
  cancel(id: string, reason?: string): boolean;
  dismiss(id: string): boolean;
  /** `handOrdered` is the host's own field (a client cannot set it) and marks a
   *  position a PERSON decided — a drag, or an assessment ranking they approved. */
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
   * the entire rank loop had still to happen, so the row went without the
   * approved order applied to it. The person's ranking was written a moment after the only fire it was
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
  /** A slot check (`AssessScope`): `ids` must then all still sit in that slot. */
  slotScope?: unknown,
): { runId: string } | { error: string } {
  const busy = store.running(repoDir);
  if (busy) return { error: "an assessment is already running for this repo — two of them would propose different verdicts on one list" };
  /**
   * **A slot check judges exactly the rows the person was shown — or nothing.**
   *
   * The phone's `ids` are what the person saw when they tapped; the host's rows
   * are what will fire. The key is matched back against the live rows
   * (`findSlot`, tolerant — the two ends read one reset a minute apart) only to
   * CONFIRM the caller's list, never to replace it: `slotsOf` clusters greedily
   * from the earliest row, so one row posted since (an agent's `new` two
   * minutes before `a`) moves the cut, and a run over the host's slot judged a
   * row nobody saw and dropped one they did. So every id sent must still be
   * waiting and still sit in the host's slot, and at least two must — else the
   * check is REFUSED in a sentence, with no model call. A key that names
   * nothing any more, or a slot down to one row, is refused the same way:
   * a check of one row against itself buys nothing, and widening to the repo is
   * the most expensive wrong answer available. Rows in the slot that were not
   * sent are never judged.
   */
  const slot = cleanAssessScope(slotScope);
  if (slotScope !== undefined && !slot) return { error: "that slot check names no slot — nothing was run" };
  if (slot) {
    const rows = intents.list()
      .filter((i) => i.cwd === repoDir && i.payload.kind === "prompt" && ASSESSABLE_STATES.has(i.state))
      .map(slotRowOfIntent)
      .filter((r): r is SlotRow => !!r);
    const found = findSlot(rows, slot.key);
    if (!found) {
      return { error: "those rows no longer fire together — they ran, were moved, or the reset they waited for has changed; nothing was run" };
    }
    if (found.ids.length < 2) {
      return { error: "only one row fires at that time now, so there is nothing to check together; nothing was run" };
    }
    const sent = [...new Set((ids ?? []).filter((x) => typeof x === "string"))];
    const inSlot = new Set(found.ids);
    if (sent.length < 2 || !sent.every((x) => inSlot.has(x))) {
      return { error: `the slot changed since you looked — it now holds ${found.ids.length}; open the check again. Nothing was run` };
    }
    return postRun(intents, repoDir, { kind: "assess", ids: sent, scope: slot });
  }
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
  return postRun(intents, repoDir, scope ? { kind: "assess", ids: scope } : { kind: "assess" });
}

/** The run row itself — one tap, one durable row. */
function postRun(intents: AssessIntents, repoDir: string, payload: AssessPayload): { runId: string } | { error: string } {
  const runId = "as_" + randomUUID().slice(0, 8);
  const posted = intents.post({
    id: runId,
    cwd: repoDir,
    payload,
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