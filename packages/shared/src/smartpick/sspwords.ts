/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/shared-architecture.md. */
import { type SmartPickOutcomeFacts } from "./ssptypes.js";
import { SMARTPICK_FIRED_AS_WAS, SMARTPICK_NOOP_TEXT, SMARTPICK_UNREADABLE } from "./sspconst.js";

// ── What the strip says ──────────────────────────────────────────────────────

/** Seconds, the way the sentences say them: "20 s", "0.8 s". */
function secs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s >= 10 || Number.isInteger(s) ? `${Math.round(s)} s` : `${s.toFixed(1)} s`;
}

/** "9 s" / "4 min" — how long ago the previous look was. Coarse on purpose: the
 *  sentence is about whether it was JUST NOW, not about the exact gap. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/**
 * One sentence for what a pass did, or for why it did nothing.
 *
 * **These strings are the contract.** The phone renders them verbatim under the
 * repo bar and `packages/shared/test/smartpick.test.mjs` pins every one; a
 * reword edits the test in the same change. They are here rather than in the
 * client because the host writes the same sentence into a notification and the
 * record, and three copies of "fired in the order you had" is three chances for
 * one of them to stop being true.
 *
 * `failed`, `timeout`, `limited` and the churn-guard `skipped` end on
 * `SMARTPICK_FIRED_AS_WAS`, which is the promise: a pass that goes wrong costs
 * a few seconds and changes nothing.
 *
 * The two that do NOT are the two where the promise would be beside the point
 * rather than reassuring, and the distinction is worth keeping exact because a
 * test that only checked "it ends on the promise" would have to be wrong about
 * one of them: `skipped` with no `sinceMs` is the unchanged fingerprint, which
 * bought nothing and claims nothing, and `late` is an answer that arrived after
 * the item had already started — "fired in the order you had" would be telling
 * somebody the backlog was untouched by an event that is about the backlog
 * having moved on without it.
 */
export function smartpickOutcomeText(s: SmartPickOutcomeFacts): string {
  const fired = ` — ${SMARTPICK_FIRED_AS_WAS}`;
  switch (s.outcome) {
    case "applied": {
      const parts: string[] = [];
      if (s.picked) parts.push(`picked “${s.picked}”`);
      // "merged 5 → 2" needs both numbers, which is why both are stored; an
      // absent `mergedInto` is therefore a record that did not say, and the
      // sentence says what it has instead of deriving the other half. The old
      // `?? 1` printed "merged 3 → 1" about three items that may have become
      // two rows — the one claim this field pair exists to make impossible.
      if (s.merged > 0) parts.push(s.mergedInto != null ? `merged ${s.merged} → ${Math.max(1, s.mergedInto)}` : `merged ${s.merged}`);
      if (s.sorted > 0) parts.push(`sorted ${s.sorted}`);
      return parts.length ? parts.join(" · ") : SMARTPICK_NOOP_TEXT;
    }
    case "noop":
      return SMARTPICK_NOOP_TEXT;
    case "skipped":
      // Two skips, and the difference is whether any time was spent: the churn
      // guard has a gap to report, the unchanged fingerprint has nothing to
      // claim about the clock and must not invent one.
      return s.sinceMs == null
        ? "nothing changed since the last look"
        : `looked ${ago(s.sinceMs)} ago${fired}`;
    case "failed":
      return `${s.detail?.trim() || SMARTPICK_UNREADABLE}${fired}`;
    case "timeout":
      return `timed out after ${secs(s.durationMs)}${fired}`;
    case "limited":
      return `the account is at its usage limit${fired}${s.detail?.trim() ? ` · ${s.detail.trim()}` : ""}`;
    case "late":
      return "an answer arrived after the item had already started — not applied";
  }
}