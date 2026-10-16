/**
 * **Whether the desktop-CLI update strip is up, and what dismissing it means.**
 *
 * Lifted out of `App.tsx`'s `renderUpdateBanner` because the × on that bar did
 * nothing in the two states people most want gone. The old rule was:
 *
 *     if (update.available && !running && !recentResult && dismissed === sig)
 *
 * — a dismissal only counted while an update was AVAILABLE and no result was
 * fresh. So the bar that says "Updated: updated to 2.1.267" (available is
 * already false, `recentResult` is true) and the bar carrying a standing
 * `lastError` both swallowed the tap and sat there. The signature was the
 * version pair alone, which cannot tell those two bars apart from each other
 * anyway: after an upgrade the pair does not move.
 *
 * The rule here instead: the signature names EVERY reason the bar can be up —
 * the version pair, the result it is reporting, the error it is carrying — and
 * a dismissal hides exactly that bar. A newer release, a fresh `brew upgrade`
 * result or a new error is a different signature and shows through on its own.
 * An upgrade in flight is never hidden: the × is disabled while it runs, and
 * the log under the bar is the only place that upgrade is visible.
 *
 * No local-module value imports here — the web unit-test layer runs this off
 * the TypeScript directly, so it must never reach for the DOM.
 */
import type { UpdateInfo } from "@waterplane/shared";

/** How long a finished `brew upgrade` keeps the bar up by itself. */
export const RESULT_FRESH_MS = 30_000;

export interface UpdateBarView {
  /** Render the bar at all. */
  show: boolean;
  /** What a × press should record — meaningless when `show` is false. */
  sig: string;
  /** The last apply finished recently enough to still be worth saying. */
  recentResult: boolean;
  /** Draw the apply button. Only while there is something to apply: after a
   *  clean upgrade the bar stays up for its "Updated: …" line, and an "update"
   *  button beside that read as if the upgrade had not happened. A run that
   *  moved nothing (cask lagging npm) leaves `available` true, so it stays. */
  canApply: boolean;
  /** When the fresh result goes stale and the bar must be re-read, or null. */
  staleAt: number | null;
}

export function updateBarView(u: UpdateInfo | null, dismissed: string, now: number): UpdateBarView {
  if (!u) return { show: false, sig: "", recentResult: false, canApply: false, staleAt: null };
  const recentResult = !!u.lastResult && now - u.lastResult.at < RESULT_FRESH_MS;
  const canApply = !!u.available;
  const staleAt = recentResult ? u.lastResult!.at + RESULT_FRESH_MS : null;
  const sig = [u.current ?? "", u.latest ?? "", u.lastResult?.at ?? 0, u.lastError ?? ""].join("|");
  // Nothing to act on: no update, nothing running, no fresh result, no error.
  if (!u.available && !u.running && !recentResult && !u.lastError) return { show: false, sig, recentResult, canApply, staleAt };
  if (!u.running && dismissed === sig) return { show: false, sig, recentResult, canApply, staleAt };
  return { show: true, sig, recentResult, canApply, staleAt };
}
