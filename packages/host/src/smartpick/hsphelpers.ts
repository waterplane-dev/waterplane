/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import { createHash } from "node:crypto";
import type { Intent, SmartPickCandidate, SmartPickSummary } from "@waterplane/shared";
import { budgetWaived, describeRule, isBacklogRow, isTimedWorkRow, timedWorkKey, SMARTPICK_MAX_ITEMS } from "@waterplane/shared";
import { sidecarPlan } from "../sidecar.js";
import { SMARTPICK_MODEL } from "./hspknobs.js";

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * May a pass decide about this row?
 *
 * The same predicate answers both questions the ladder asks — "is the row that
 * is about to fire one of these?" and "which rows is the pass allowed to sort?"
 * — because two spellings of it would be two answers, and the disagreement would
 * be a pass reordering rows around one it was never shown.
 *
 * Every exclusion is a row somebody aimed on purpose: `pinned` is *queue here*,
 * a session target is a named session, an `after` trigger has its own clock, an
 * archived row is set aside, and a row with no `auto` was fired by a tap.
 */
export function isCandidateRow(r: Intent): boolean {
  return isBacklogRow(r)
    && r.target.kind === "repo"
    && r.auto === true
    && !r.pinned
    && !r.archived
    // A `manual` row (an agent's backlog add) waits for a person's tap, and a
    // merge would mint an ordinary `auto` row out of its words — the one way
    // around rung 1's hold. It is not waiting work until somebody fires it.
    && !r.manual
    && (r.state === "queued" || r.state === "blocked")
    // A one-off with a clock is in here for the same reason it is in
    // `isBacklogRow`: recurrence, not trigger kind, decides which list a row
    // lives in, and the user's whole ask was that the items in their scheduler
    // be groomed like the rest of their waiting work. The pass SEES it — it is
    // in the prompt with its clock and it is hashed into the fingerprint — and
    // the three verbs then meet it differently: pinned in the sort, never the
    // pick, merged only with a twin on the identical clock. All three are
    // `shared/smartpick.ts`'s, so the rule is stated once.
    && (r.trigger.kind === "idle" || r.trigger.kind === "now" || isTimedWorkRow(r));
}

export function toCandidate(r: Intent, now: number): SmartPickCandidate {
  const steps = r.payload.kind === "prompt" ? r.payload.steps : [];
  // The clock, twice over and for two different jobs: `at` is PROSE for the
  // model to read (so its `why` is not nonsense about ordering something it may
  // not order) and `atKey` is the EQUALITY every rule downstream is decided on.
  // `timedWorkKey` is that equality's one implementation — a second spelling of
  // "the same clock" here would be a second answer to whether two rows may be
  // folded into one.
  const atKey = timedWorkKey(r);
  const at = r.trigger.kind === "at" && atKey ? describeRule(r.trigger.rule) : undefined;
  return {
    id: r.id,
    text: steps[0] ?? "",
    label: r.label,
    order: r.order ?? r.createdAt,
    resume: r.resume,
    handOrdered: r.handOrdered,
    steps: steps.length || 1,
    // The hold travels WHATEVER the clock did. It is inside `atKey` for a timed
    // row, and *drop the clock* deliberately leaves it on a row that has none —
    // so the rows this pass is most likely to meet are exactly the ones the key
    // says nothing about. See `SmartPickCandidate.holdForHost`.
    ...(r.holdForHost ? { holdForHost: true } : {}),
    // A waiver IN FORCE — an expired one is no answer about this window.
    ...(budgetWaived(r, now) ? { pastBudget: true } : {}),
    ...(atKey ? { at, atKey } : {}),
  };
}

/**
 * The merged row's id, minted here because it cannot be pure.
 *
 * `applySmartPick` hands back a `key` (`merge:0`) and deliberately not an id: an
 * id has to be DETERMINISTIC across a crash and a replay, and the pass id it is
 * derived from is not a pure fact. Eight characters, matching every other work
 * item's `randomUUID().slice(0, 8)`, with an `mg` prefix so a row read off disk
 * says where it came from before anything is joined to it.
 */
export function mergedRowId(passId: string, ids: readonly string[]): string {
  return `mg${createHash("sha1").update(`${passId}|${[...ids].sort().join(",")}`).digest("hex").slice(0, 6)}`;
}

/** The note that says what the pass did NOT look at. Silence about an item the
 *  cap left out would be a clean sweep reported over half a backlog. */
export function notesFor(omitted: number): string[] {
  return omitted > 0 ? [`${omitted} more waiting ${omitted === 1 ? "item was" : "items were"} not looked at — the pass takes ${SMARTPICK_MAX_ITEMS} at a time, and the rest kept their places.`] : [];
}

/** What the strip calls the picked item: a person's label, or the first line of
 *  their words. Never the id, which means nothing to whoever reads it. */
export function pickedName(
  pick: string | null,
  proposal: { merges: { ids: string[]; text: string }[] },
  cands: readonly SmartPickCandidate[],
  mergedIds: readonly string[],
): string | undefined {
  if (!pick) return undefined;
  const m = /^merge:(\d+)$/.exec(pick);
  if (m) {
    const g = proposal.merges[Number(m[1])];
    // A merge whose apply was dropped is not something that was picked.
    return g && mergedIds.length ? oneLine(g.text) : undefined;
  }
  const c = cands.find((x) => x.id === pick);
  if (!c) return undefined;
  return oneLine(c.label || c.text);
}

/** A row's first turn, which is the text a candidate was cut from. */
export const firstStep = (r: Intent): string => (r.payload.kind === "prompt" ? r.payload.steps[0] ?? "" : "");

/** Does the row still say what the model was shown? A CLIPPED candidate was
 *  only ever sent as its first few hundred characters and `cleanSmartPick`
 *  refuses to merge one, so there is nothing here to compare it against —
 *  answering "changed" for it would drop a merge it could not be in. */
export const sameWords = (r: Intent, c?: SmartPickCandidate): boolean =>
  !c || !!c.clipped || firstStep(r) === c.text;

export const oneLine = (s: string): string => (s.trim().split("\n")[0] ?? "").trim().slice(0, 60) || "an item";
export const baseName = (p: string): string => p.split(/[/\\]/).filter(Boolean).pop() || p;

/**
 * Which engine this repo's passes run on, and on what model — asked of
 * `sidecar.ts`'s router rather than assumed.
 *
 * It rides on every record, a skipped one included: "which engine" is a fact
 * about how this desktop is configured, not about whether one call happened, and
 * a strip that says nothing about it on the cheap outcomes would read as two
 * different features. A REFUSED route names no model, because nothing ran on
 * one and naming a model that never saw the prompt is the wrong number this
 * whole seam refuses.
 */
export function route(): { engine: SmartPickSummary["engine"]; model?: string } {
  const plan = sidecarPlan("smartpick");
  if (plan.engine === "openai-compat") return { engine: "openai-compat", model: plan.model };
  if (plan.engine === "claude-p") return { engine: "claude-p", model: SMARTPICK_MODEL };
  return { engine: "claude-p" };
}