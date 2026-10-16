/**
 * The halt's words on the phone. The sentences about WHAT a halt does live in
 * `shared/halt.ts` so the host's refusal and this screen agree; this is only
 * the banner's line and the confirm's lines.
 */
import { BRAND, haltReceiptWords, type HaltState } from "@waterplane/shared";

/** The confirm's body: what stops, what waits, and what it cannot reach. */
export const HALT_CONFIRM_LINES: readonly string[] = [
  `Every agent session ${BRAND.displayName} started on this desktop ends now, with the tools it is running — open or in the background.`,
  "Background model runs (review, naming, assessments) stop too.",
  "Nothing automatic starts again until you lift the halt: schedules, the backlog and limit resumes wait.",
  `Shell sessions keep running. AI started outside ${BRAND.displayName}, and cloud sessions, are not reached.`,
];

const hhmm = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The banner's line: since when, and — once the kill has finished — what it did. */
export function haltBannerWords(h: HaltState, now = Date.now()): string {
  const since = h.since == null ? "" : now - h.since < 20 * 3600_000 ? ` since ${hhmm(h.since)}` : ` since ${new Date(h.since).toLocaleDateString()}`;
  const head = `All AI halted${since}.`;
  const fresh = h.receipt && h.since != null && h.receipt.at >= h.since;
  return fresh ? `${head} ${haltReceiptWords(h.receipt!)}` : `${head} Stopping…`;
}
