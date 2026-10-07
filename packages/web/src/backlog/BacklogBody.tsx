/**
 * The sheet's scrolling body, in its two orders.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import type { BacklogModel } from "./backlogTypes";
import { RepoBar } from "./RepoBar";
import { AutoOffNote, HereNotice, StrandedDraft } from "./Notices";
import { SmartPickNotes } from "./SmartPickNotes";
import { BacklogFilterBar, CutBar } from "./BacklogFilterBar";
import { BulkBars } from "./BulkBars";
import { BacklogList } from "./BacklogList";

/**
 * **An ids cut leads with its rows.** It is opened FROM somewhere — a
 * requirements update handed over, an applied assessment, a schedule's row —
 * by somebody who wants the words and the `fire` that starts them. Under the
 * repo bar, the chips and the bulk bars that row sat a scroll below the fold,
 * and a tap that had only QUEUED work read as one that had run it. So: what
 * the cut is, then the rows, then the rest. `key` resets the scroll per cut.
 */
export function BacklogBody({ m }: { m: BacklogModel }) {
  const { filter } = m;
  return (
    <div className="sheet-scroll" key={filter.ids ? filter.ids.join(",") : ""}>
      {filter.ids ? (
        <>
          <CutBar m={m} />
          <AutoOffNote m={m} />
          <BacklogList m={m} />
          <BulkBars m={m} />
          <RepoBar m={m} />
          <SmartPickNotes m={m} />
          <StrandedDraft m={m} />
          <HereNotice m={m} />
          <BacklogFilterBar m={m} />
        </>
      ) : (
        <>
          <RepoBar m={m} />
          <AutoOffNote m={m} />
          <SmartPickNotes m={m} />
          <StrandedDraft m={m} />
          <HereNotice m={m} />
          <BacklogFilterBar m={m} />
          <BulkBars m={m} />
          <BacklogList m={m} />
        </>
      )}
    </div>
  );
}
