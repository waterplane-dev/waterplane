/**
 * The money pieces every view shares, so the rules live once:
 *  - a dollar total is never printed without its split (`KindBar`),
 *  - a dollar figure is a list-price counterfactual and says so, with the date of the table,
 *  - a cost of null prints no dollars at all (never "$0").
 */
import { DOLLARS_WHY, DOLLARS_WHY_HEAD, PRICES_AS_OF, fmtUsd, type CostBreakdown, type TokenTotals } from "@waterplane/shared";
import { KindBar } from "@waterplane/kit";

/** A cost breakdown as the bag `KindBar` paints: costs under the kind ids, the two non-kind fields zero. */
export function costBag(c: CostBreakdown): TokenTotals {
  return { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, cacheWrite1h: 0, turns: 0 };
}

export { addCosts, pricedOrNull } from "../src/data/sessiontotal";

/** The standing framing under any dollar figure. */
export function ListPrice() {
  return (
    <div className="empty ts-caveat list-price">
      List price, not your bill — what the same tokens would cost through the API, prices as of {PRICES_AS_OF}.
      <details className="hint-more">
        <summary>{DOLLARS_WHY_HEAD}</summary>
        <p>{DOLLARS_WHY}</p>
      </details>
    </div>
  );
}

/** A dollar total, its four-way split, and the framing. Never a bare total. */
export function CostBlock({ cost, label, children }: { cost: CostBreakdown; label: string; children?: React.ReactNode }) {
  return (
    <div className="cost-block">
      <div className="cost-head">
        <span className="cost-total" title={label}>{fmtUsd(cost.total)}</span>
        <span className="cost-label">{label}</span>
      </div>
      <div className="ctx-summary">What the dollars were spent on:</div>
      <KindBar bag={costBag(cost)} whole={cost.total} fmt={fmtUsd} exact={fmtUsd} />
      {children}
      <ListPrice />
    </div>
  );
}
