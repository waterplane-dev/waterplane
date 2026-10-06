/**
 * The launcher topbar chip over this feature's rollup. Moved verbatim out of
 * App (the topbar IIFE).
 */
import { Waypoints } from "lucide-react";
import { useStore } from "../../sdk";
import { chipShown, chipSplit, chipVerdicts } from "./logic";
import { rollup } from "./store";
import { openCliHealth } from "./actions";

const ICON = 16;

/**
 * The unprompted mark for Decision 8.
 *
 * "Loud means: on the phone, unprompted" — every one of these ten readings
 * degrades to nothing rather than to a wrong answer, and degrading to nothing
 * is silent by construction. This chip is the whole difference between a
 * feature and a tree falling in an empty forest.
 *
 * It sits on the TOPBAR rather than beside the "N at limit" chip that inspired
 * it, and the reason is that chip's own condition: "N at limit" lives inside
 * the Live-sessions section head, which is not rendered at all when no session
 * is live. A broken heuristic is most likely to be noticed when nothing seems
 * to work — which is precisely when that section is empty and the mark would
 * vanish. The topbar is unconditional, and this belongs beside the usage
 * readout anyway: both are facts about the desktop's account and its binary,
 * not about one session.
 *
 * `unknown` and `healthy` render NOTHING (`chipShown`). The rollup already
 * encodes that rule (`healthRollup`'s own note: a badge that goes grey whenever
 * a rarely-exercised signal has not fired today is a badge nobody reads), so
 * there is no second rule here to drift from it.
 *
 * Icon + a count, the shape the bell beside it already has: the topbar wraps
 * to three rows on a phone and "CLI: 2 broken · 2 degraded" spelled out was
 * most of one of them. What survives on screen is the NUMBER — the
 * load-bearing fact, never a `title` alone, which is invisible on a phone. The
 * split by kind is the sentence, and it rides in `title` (mouse) AND
 * `aria-label` (screen reader) because the sheet this opens restates it on tap
 * — one tap away is a different thing from nowhere.
 */
export function CliHealthChip() {
  const r = useStore(rollup);
  if (!chipShown(r)) return null;
  const split = chipSplit(r);
  const line = r.lines[0] ?? "the CLI integration is degraded";
  return (
    <button className={`key cli-health-key ${r.verdict === "broken" ? "danger" : "warn"}`}
      title={`CLI: ${split}\n${line}\ntap for just these`}
      aria-label={`CLI health — ${split}. ${line}. tap for just these`}
      // No `track` here: App counts every overlay it opens (`overlay:clihealth`).
      onClick={() => openCliHealth(chipVerdicts(r))}>
      {/* Ten signals exist in all, so the count never needs a "9+". */}
      <Waypoints size={ICON} />
      <span className="cli-health-badge">{r.broken.length + r.degraded.length}</span>
    </button>
  );
}
