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
import { peerWeekSpend, weekCalSpend, weekUsdPerPct, type UsageInfo } from "@waterplane/shared";
import { ledgers } from "../../sdk";
import { WEEK_MS, weekCalKey } from "./logic";
import { usage, weekAllDesktops, weekRate } from "./store";

let asked: string | null = null;

export function calibrateWeek(u: UsageInfo | null): void {
  const base = weekCalKey(u, Date.now());
  const all = weekAllDesktops.get();
  const key = base && `${base}:${all ? "all" : "here"}`;
  if (!u || !key || key === asked || weekRate.get()?.key === key) return;
  asked = key;
  const openedAt = u.weeklyResetAt! - WEEK_MS;
  // The peer jobs this desktop sent spent on the SAME account (a paired desktop usually signs in
  // as the same person), so they are in the percentage and not in this ledger: added to the spend
  // side, wholly-inside-the-window jobs only, and SAID (`incl. $0.84 on pc`). A host that cannot
  // answer (older, or not the trusted path) adds nothing — the estimate is then this desktop's
  // alone, as it always was.
  // Paired desktops' OWN week (`weekCalSpend`): summed when the person's switch says so, and
  // otherwise only asked whether one of them spent more — then this desktop's figure is refused.
  // A host without the route answers nothing, and the calibration is this desktop's as before.
  Promise.all([
    ledgers.tokenWindows([{ id: "weekcal", anchor: u.checkedAt, lenMs: u.checkedAt - openedAt }]),
    ledgers.peerJobs().catch(() => null),
    ledgers.peersWeekSpend(openedAt, u.checkedAt).catch(() => null),
  ])
    .then(([d, jobs, peers]) => {
      const cell = d.series.find((s) => s.id === "weekcal")?.windows.find((w) => w.back === 0);
      const spend = weekCalSpend({ here: cell?.cost.total, jobs: peerWeekSpend(jobs, openedAt, u.checkedAt), peers, weeklyResetAt: u.weeklyResetAt!, sumAll: all });
      // Only for the reading still on hand; an older host or an empty week
      // leaves the share absent.
      if (!spend || weekCalKey(usage.get(), Date.now()) !== base) return;
      if ("refused" in spend) { weekRate.set({ key, resetAt: u.weeklyResetAt!, usdPerPct: null, refused: spend.refused }); return; }
      const v = weekUsdPerPct(spend.usd, u.weeklyPct);
      if (v != null) weekRate.set({ key, resetAt: u.weeklyResetAt!, usdPerPct: v, ...(spend.incl ? { incl: spend.incl } : {}) });
    })
    .catch(() => undefined)
    // A failed read is retried by the next reading, never stuck for this one.
    .finally(() => { if (asked === key) asked = null; });
}

/** The switch moved (`weekAllDesktops`): measure the reading on hand again under it. */
export function recalibrateWeek(): void {
  weekRate.set(null);
  calibrateWeek(usage.get());
}
