import { Search, X } from "lucide-react";
import { Empty } from "./Empty";

/**
 * The Schedules sheet's search box — words on a card or a line, and its repo's
 * name (`clockCuts`' `text`).
 *
 * It narrows ON TOP of whatever cut the sheet was opened on, never instead of
 * it: a chip's tap lands on "29 of 30", and finding one row among those 29 is
 * the reason the box exists. So the filter bar keeps counting its own cut and
 * the box counts against that cut — each number is the length of the list its
 * own control opens. Drawn only when there is something to search, and kept
 * while a query matches nothing, or the way out would vanish with the rows.
 */
export function ScheduleSearch({ query, setQuery, cutTotal, shownTotal }: {
  query: string;
  setQuery: (q: string) => void;
  cutTotal: number;
  shownTotal: number;
}) {
  const searching = query.trim() !== "";
  if (cutTotal <= 1 && !searching) return null;
  return (<>
    <div className="section quick-filter">
      <Search size={14} className="quick-filter-icon" />
      <input type="search" value={query} placeholder="search these schedules"
        aria-label="search the schedules by their words or repo"
        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); } }} />
      {searching && <span className="quick-filter-n">{shownTotal} of {cutTotal}</span>}
      {searching && (
        <button className="head-act" aria-label="clear the search" title="clear the search — every row of the cut again"
          onClick={() => setQuery("")}><X size={16} /></button>
      )}
    </div>
    {searching && shownTotal === 0 && <Empty>Nothing here matches “{query.trim()}”.</Empty>}
  </>);
}
