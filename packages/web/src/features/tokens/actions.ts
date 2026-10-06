/**
 * The writer of `weekRate`: what one percent of the weekly limit is worth in
 * list-price dollars, measured off the reading that just arrived.
 *
 * The spend side is the host's ledger folded into ONE cell from the top of the
 * hour the weekly window opened in up to the scrape's own instant
 * (`/api/tokenwindows`, anchor = `checkedAt`), so the money and the percentage
 * describe the same stretch to within the hour the scrape fell in — never "the
 * window so far", which would count spend the percentage never saw.
 */
import { peerWeekSpend, weekUsdPerPct, type UsageInfo } from "@waterplane/shared";
import { ledgers } from "../../sdk";
import { WEEK_MS, weekCalKey } from "./logic";
import { usage, weekRate } from "./store";

let asked: string | null = null;

export function calibrateWeek(u: UsageInfo | null): void {
  const key = weekCalKey(u, Date.now());
  if (!u || !key || key === asked || weekRate.get()?.key === key) return;
  asked = key;
  const openedAt = u.weeklyResetAt! - WEEK_MS;
  // The peer jobs this desktop sent spent on the SAME account (a paired desktop usually signs in
  // as the same person), so they are in the percentage and not in this ledger: added to the spend
  // side, wholly-inside-the-window jobs only, and SAID (`incl. $0.84 on pc`). A host that cannot
  // answer (older, or not the trusted path) adds nothing — the estimate is then this desktop's
  // alone, as it always was.
  Promise.all([
    ledgers.tokenWindows([{ id: "weekcal", anchor: u.checkedAt, lenMs: u.checkedAt - openedAt }]),
    ledgers.peerJobs().catch(() => null),
  ])
    .then(([d, jobs]) => {
      const cell = d.series.find((s) => s.id === "weekcal")?.windows.find((w) => w.back === 0);
      const peer = peerWeekSpend(jobs, openedAt, u.checkedAt);
      const here = cell?.cost.total;
      const v = weekUsdPerPct(here != null && here > 0 ? here + (peer?.usd ?? 0) : here, u.weeklyPct);
      // Only for the reading still on hand; an older host or an empty week
      // leaves the share absent.
      if (v != null && weekCalKey(usage.get(), Date.now()) === key) {
        weekRate.set({ key, resetAt: u.weeklyResetAt!, usdPerPct: v, ...(peer ? { incl: peer.text } : {}) });
      }
    })
    .catch(() => undefined)
    // A failed read is retried by the next reading, never stuck for this one.
    .finally(() => { if (asked === key) asked = null; });
}
