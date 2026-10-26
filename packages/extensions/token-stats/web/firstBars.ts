/**
 * Geometry for the first-request strip on the costliest-conversations rows.
 *
 * One bar per row, ALL on one scale: the largest measured first request among the ranked rows
 * is full width, so two rows can be compared by eye. A conversation's own total is not the
 * yardstick (it runs to millions with cache reads; the first request would be a hairline) — the
 * question the strip answers is "what did each of these start out carrying".
 *
 * A row with no measured `firstTok` gets NO entry: absent draws nothing, never an empty or zero bar.
 * A sliver keeps the house minimum of 1% (as `Bars.tsx`, `WeekCard.tsx`, `PeriodCard.tsx`) so it is
 * still a mark — never more, or the bottom of the shared scale lies; the words line carries the figure.
 */
export const FIRST_BAR_MIN_PCT = 1;

/** Said ONCE above the list: this bar's yardstick is not the share printed in each row's head. */
export const FIRST_BAR_CAPTION = "Under each row: its first request, drawn against the largest one here.";

export function firstBarPcts(rows: ReadonlyArray<{ id: string; firstTok?: number }>): Map<string, number> {
  const out = new Map<string, number>();
  let max = 0;
  for (const r of rows) if (typeof r.firstTok === "number" && r.firstTok > 0 && r.firstTok > max) max = r.firstTok;
  if (max <= 0) return out;
  for (const r of rows) {
    if (typeof r.firstTok !== "number" || !(r.firstTok > 0)) continue;
    out.set(r.id, Math.min(100, Math.max(FIRST_BAR_MIN_PCT, (r.firstTok / max) * 100)));
  }
  return out;
}
