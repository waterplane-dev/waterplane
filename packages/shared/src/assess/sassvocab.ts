/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/shared-architecture.md. */
import { stateRel } from "../brand.js";

// ── The vocabulary ───────────────────────────────────────────────────────────

/**
 * Where one assessable item's words live — the two stores addressable by `cwd`:
 * the intent store, and the pad.
 *
 * The pad is NOT "where words go when a send gives up" any more. `retireToPad`
 * is deleted: a queue row that fails now keeps its own row and its own full
 * words for as long as it takes, so nothing is moved anywhere on a failure. The
 * pad is thoughts written with no target — which named a repo because they
 * attached a file, or were written for one — and that `cwd` is the whole reason
 * an assessment of a repo has anything to say about them.
 */
export type AssessSource = "intent" | "note";

/**
 * The verdict on one existing item.
 *
 * `unclear` is the safe direction and every downgrade lands on it: it retires
 * nothing, keeps the words where they are, and says what was ambiguous.
 */
export type AssessVerdict = "done" | "obsolete" | "superseded" | "merged" | "wanted" | "unclear";

export const ASSESS_VERDICTS: readonly AssessVerdict[] = [
  "done", "obsolete", "superseded", "merged", "wanted", "unclear",
];

/**
 * The verdicts that must cite something.
 *
 * `merged` retires a row too and is deliberately NOT in this list: its evidence
 * is the group itself — the sheet shows the new prompt in full next to all N
 * originals — and a rationale that happens to be empty must not turn a
 * reviewable merge into an unreviewable one. Everything else that retires a row
 * does so on a claim about the codebase, and a claim about the codebase without
 * a path, a line or a commit behind it is an opinion.
 */
export const CITING_VERDICTS: readonly AssessVerdict[] = ["done", "obsolete", "superseded"];

// ── The caps, and what each one is protecting ────────────────────────────────

/** A merge group's floor. One id is not a merge — it is a rewrite of somebody's
 *  sentence, which this does not offer. */
export const MIN_MERGE_SIZE = 2;

/**
 * A merge group's ceiling.
 *
 * Six, because past that a "merge" stops being "these are facets of one job"
 * and becomes a list flattened into a sentence, which is precisely how the
 * detail in eighty-four prompts dies. Over the cap the group is dropped and its
 * members fall back to `unclear` — they keep their own words, which is the
 * whole trade.
 */
export const MAX_MERGE_SIZE = 6;

/** How many groups one run may propose. A run that wants to merge half the
 *  repo has understood the assignment as a rewrite. */
export const MAX_MERGE_GROUPS = 20;

/**
 * How many genuinely new items one run may add.
 *
 * An assessment that proposes thirty new things has misunderstood the
 * assignment, and this cap is the place that says so out loud rather than a
 * scroll that hides it. The extras are dropped and NOTED, never clipped.
 */
export const MAX_NEW = 10;

/** A citation is a label — a path, a line, a commit, a short sentence. Clipping
 *  one loses nothing a person needs, and an unbounded string here is written by
 *  a model into a row rendered on a phone. */
export const MAX_EVIDENCE_CHARS = 400;

/** Same, for a merge group's rationale, which gets a sentence rather than a
 *  citation and so is allowed to be longer. */
export const MAX_RATIONALE_CHARS = 600;

/**
 * A prompt is not a label: it is the thing that will RUN.
 *
 * So it is never truncated. Past this it is DROPPED, with a note saying which
 * group or item went — `IntentPayload.steps`' promise ("kept in FULL, forever,
 * un-clipped") applied one step earlier, at the point the words are proposed
 * rather than the point they are stored.
 */
export const MAX_PROMPT_CHARS = 20_000;

/** A rank is a sort position, not a score. Out-of-range values are clamped
 *  rather than dropped: a bad number must not cost the row its verdict. */
export const MAX_RANK = 9999;

/** How many refusal notes are kept for the sheet. A dropped group that says
 *  nothing is indistinguishable from a group nobody proposed. */
export const MAX_ASSESS_NOTES = 40;

/** The contract with the CLI, both directions. Named here rather than in the
 *  host because the prompt builder, the reader and the sheet all say them, and
 *  three spellings of one path is a run that reads its own stale output. */
export const ASSESS_IN_FILE = stateRel("assess-in.json");
export const ASSESS_OUT_FILE = stateRel("assess-out.json");
export const ASSESS_PLAN_FILE = stateRel("plan.md");

// ── Two string helpers every cleaner slice uses (not on the barrel) ──────────

/** A trimmed string, or "" for anything that is not one. */
export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** A LABEL clipped to `n` — never applied to a prompt (see `MAX_PROMPT_CHARS`). */
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

// ── The slot check's two proposal kinds (2026-10-16) ─────────────────────────

/**
 * How many contradictions one run may name. A conflict is WORDS — it changes
 * no row, ever — so the cap is only about a sheet staying readable.
 */
export const MAX_CONFLICTS = 10;

/** How many rows a conflict may name. Two is the usual case; past six it is a
 *  theme, not a contradiction a person can resolve by editing one row. */
export const MAX_CONFLICT_IDS = 6;

/** How many splits one run may propose. */
export const MAX_SPLITS = 10;

/** A split is exactly this many texts: one row that is two jobs. A three-way
 *  split is two splits, approved one at a time. */
export const SPLIT_PARTS = 2;

/**
 * **What a run was scoped to, beyond its ids** — absent is a plain run.
 *
 * `slot`: the ids are one slot (`intent/slot.ts`) — rows that fire together at
 * one reset or instant — so the prompt can say "these fire together at X" and
 * a `wanted` rank is the order WITHIN the slot. `key` is `Slot.key`; the host
 * re-derives the slot with `findSlot` (tolerant: the phone may have read the
 * reset a minute apart) and never trusts the phone's membership over its own.
 */
export type AssessScope = { kind: "slot"; key: string };

/** `AssessScope` off the wire or disk: the one shape, else undefined. */
export function cleanAssessScope(v: unknown): AssessScope | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (r.kind !== "slot" || typeof r.key !== "string" || !r.key.trim() || r.key.length > 200) return undefined;
  return { kind: "slot", key: r.key.trim() };
}