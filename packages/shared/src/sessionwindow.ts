/**
 * Does this account HAVE a 5-hour window at all?
 *
 * Some plans dropped it (2026-10, "Ultra", formerly Max 20x): `/usage` prints the
 * weekly rows and no "Current session" row. The scrape already reads that as
 * `sessionPct: null` — but null is also "the window just reset" and "that row did
 * not parse this time", so null alone must never be read as "no window". This is
 * the ONE rule that tells them apart, from the kept history (`usagelog.ts`):
 *
 * - the trailing run of readings that named the WEEK but no session figure and no
 *   session reset (a window that reset still had its reset instant on the screen
 *   that read it);
 * - at least `SESSION_GONE_MIN_READINGS` of them, spanning `SESSION_GONE_MIN_MS`,
 *   so one torn frame never collapses the chip.
 *
 * Absent = has a window, or nobody can say yet. The moment a reading carries a
 * session figure again the run is broken and the window is back, unasked.
 */
import type { UsageSample } from "./wire/telemetry.js";

export const SESSION_GONE_MIN_READINGS = 2;
export const SESSION_GONE_MIN_MS = 20 * 60_000;

/** Epoch ms of the first reading in the trailing no-5-hour-row run, or null. */
export function sessionWindowGoneSince(samples: readonly UsageSample[]): number | null {
  let first: UsageSample | null = null;
  let n = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const r = samples[i];
    if (r.s != null || r.sr != null || r.w == null) break;
    first = r;
    n++;
  }
  if (!first || n < SESSION_GONE_MIN_READINGS) return null;
  const last = samples[samples.length - 1];
  return last.t - first.t >= SESSION_GONE_MIN_MS ? first.t : null;
}

/** The one sentence for it, on every surface that collapses the 5-hour figure. */
export function sessionWindowGoneText(): string {
  return "No 5-hour window on this plan: claude's /usage shows only the weekly limit."
    + " The 5-hour figure comes back by itself if /usage shows it again.";
}
