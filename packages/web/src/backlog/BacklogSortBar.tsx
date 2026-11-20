/**
 * **The draw order** — newest first (the default) or run order. A view, never
 * a move (`rowSort.ts`): the number on each row stays its run seat, and the
 * move verbs are drawn only in run order. Above the chips, so a person who
 * came to find what they just added sees the switch first.
 *
 * A REGION of the backlog sheet: no hooks of its own, only the model.
 */
import { SORT_CLOCK_NOTE, SORT_LABEL, SORT_NEWEST_NOTE, type BacklogSort } from "../backlogFilter";
import { Explain } from "../Explain";
import { FilterChip } from "../kit/FilterChip";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";

const SORTS: BacklogSort[] = ["newest", "run", "value", "cost"];

export function BacklogSortBar({ m }: { m: BacklogModel }) {
  const { base, drawSort, setSort, sort } = m;
  if (base.length < 2) return null;
  return (
    <div className="ts-filter bl-sort" role="group" aria-label="sort">
      <span className="ctx-stackpick-lab">sort</span>
      {SORTS.map((o) => (
        <FilterChip key={o} on={sort === o} clears={false}
          onClick={() => {
            if (o === "run") track("action:backlog.sort.run");
            else if (o === "value") track("action:backlog.sort.value");
            else if (o === "cost") track("action:backlog.sort.cost");
            else track("action:backlog.sort.newest");
            setSort(o);
          }}>
          {SORT_LABEL[o]}
        </FilterChip>
      ))}
      <Explain of="the sort">
        <p>Newest first draws the rows most recently added at the top. Run order is the order they will start in. Value draws high value first, cheapest first among equals; cheapest draws the lowest estimate first. Rows with no value or no dollar estimate come last.</p>
        <p>In every order but start order, {SORT_NEWEST_NOTE}.</p>
        {drawSort !== sort ? <p>Right now {SORT_CLOCK_NOTE}.</p> : null}
      </Explain>
    </div>
  );
}
