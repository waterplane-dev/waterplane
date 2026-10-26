/**
 * The sheet's scrolling body.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import type { BacklogModel } from "./backlogTypes";
import { RepoBar } from "./RepoBar";
import { AutoOffNote, HereNotice, StrandedDraft } from "./Notices";
import { BacklogFilterBar, CutBar } from "./BacklogFilterBar";
import { BulkBars } from "./BulkBars";
import { PickBars } from "./PickBars";
import { BacklogList } from "./BacklogList";

/**
 * **Controls sit above the rows, in every cut.** An ids cut used to lead with
 * its rows and push the repo bar, search and chips under the list — so the
 * filters were found only by scrolling past every row they filter (owner,
 * 2026-10-25: never put buttons and filters at the end of a list). An ids cut
 * now differs only in its `CutBar` on top, saying what the cut is. `key`
 * resets the scroll per cut.
 */
export function BacklogBody({ m }: { m: BacklogModel }) {
  const { filter } = m;
  return (
    <div className="sheet-scroll" key={filter.ids ? filter.ids.join(",") : ""}>
      {filter.ids && <CutBar m={m} />}
      <RepoBar m={m} />
      <AutoOffNote m={m} />
      <StrandedDraft m={m} />
      <HereNotice m={m} />
      <BacklogFilterBar m={m} />
      <PickBars m={m} />
      <BulkBars m={m} />
      <BacklogList m={m} />
    </div>
  );
}
