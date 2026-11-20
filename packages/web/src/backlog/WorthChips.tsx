/**
 * The VALUE and COST chips — the backlog's fourth and fifth cuts, ONE row (the
 * value chips, a divider, the cost chips) drawn and counted by
 * `BacklogFilterBar`'s rule: every count is the list its tap opens,
 * cross-counted against the other axes (`backlogCounts`), and a chip that would
 * cut nothing is not drawn (`drawnChips`). `no value` / `no estimate` are chips
 * like any other: the rows nobody estimated are a cut a person wants.
 *
 * A REGION of the backlog sheet: no hooks of its own, only the model.
 */
import { COST_CHIP_LABEL, VALUE_CHIP_LABEL, type drawnChips } from "../backlogFilter";
import { FilterChip } from "../kit/FilterChip";
import { chipText } from "../kit/chips";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";

export function WorthChips({ m, shown }: { m: BacklogModel; shown: ReturnType<typeof drawnChips> }) {
  const { counts, filter, pickCost, pickValue } = m;
  if (!shown.value.length && !shown.cost.length) return null;
  return (
    <div className="fchips wrap">
      {shown.value.map((v) => (
        <FilterChip key={v} on={filter.value === v}
          title={filter.value === v ? "show every value again" : v === "none" ? "show only the rows nobody gave a value" : `show only the ${v}-value rows`}
          onClick={() => { track("action:backlog.filter.value"); pickValue(v); }}>
          {chipText(VALUE_CHIP_LABEL[v], { count: counts.value[v] })}
        </FilterChip>
      ))}
      {shown.value.length > 0 && shown.cost.length > 0 && <span className="fchips-gap" aria-hidden />}
      {shown.cost.map((c) => (
        <FilterChip key={c} on={filter.cost === c}
          title={filter.cost === c ? "show every cost again"
            : c === "none" ? "show only the rows with no dollar estimate" : `show only the rows estimated at ${COST_CHIP_LABEL[c]}`}
          onClick={() => { track("action:backlog.filter.cost"); pickCost(c); }}>
          {chipText(COST_CHIP_LABEL[c], { count: counts.cost[c] })}
        </FilterChip>
      ))}
    </div>
  );
}
