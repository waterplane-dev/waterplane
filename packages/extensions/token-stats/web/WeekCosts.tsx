/** "Cost per limit week" — the weekly grid's figures as labelled bars (logic: `weekCosts.ts`). */
import { useMemo } from "react";
import { fmtUsd } from "@waterplane/shared";
import { ScopeTag } from "./TokenInsights.tsx";
import { type GridSeries, heatGrid, windowWhen } from "./usageCut.ts";
import { weekCostRows, weekCostTakeaway } from "./weekCosts.ts";
import type { WindowScope } from "./WindowHeats.tsx";

/**
 * Always in MONEY, whatever the screen's tokens/cost switch says: the section is
 * named for the dollars, and the tokens per week are one tap away on its row.
 * A row is the same decision as a weekly heat box, so a tap writes the same scope.
 */
export function WeekCosts({ grid, scope, onScope }: {
  grid: GridSeries | null;
  scope: WindowScope;
  onScope: (s: WindowScope) => void;
}) {
  const rows = useMemo(() => weekCostRows(heatGrid(grid).cells), [grid]);
  if (!rows.length) return null;
  const takeaway = weekCostTakeaway(rows);
  return (
    <>
      <div className="section section-head" data-ev="weekcosts"><span>Cost per limit week <ScopeTag>list-price US dollars</ScopeTag></span></div>
      {takeaway && <div className="empty ts-caveat">{takeaway}</div>}
      <div className="ts-bars">
        {rows.map((r) => {
          const on = scope?.id === "week" && scope.back === r.back;
          return (
            <button key={r.back} type="button" className={`ts-barrow ts-barrow-btn${on ? " on" : ""}`}
              onClick={() => onScope(on ? null : { id: "week", back: r.back })}>
              <div className="ts-barhead">
                <span className="ts-barlabel">{windowWhen(r.openedAt, r.resetAt)}{r.running ? " · running" : ""}</span>
                <span className="ts-barval">{r.usd > 0 ? fmtUsd(r.usd) : "nothing"}</span>
              </div>
              <div className="ts-bartrack">
                {r.usd > 0 && <span className="ts-barfill" style={{ width: `${Math.max(1, r.frac * 100)}%` }} />}
              </div>
            </button>
          );
        })}
      </div>
      <div className="empty ts-caveat">Newest first. Tap a week to set the span to it.</div>
      <details className="hint-more ctx-method">
        <summary>how to read the bars</summary>
        <p>
          One row per weekly limit window the hour record covers. The bar and the figure are what
          that week’s requests would cost at Anthropic’s list prices — the longest bar is the dearest
          week, which is neither good nor bad. The running week counts only so far. Always in dollars,
          whatever “count in” is set to above.
        </p>
      </details>
    </>
  );
}
