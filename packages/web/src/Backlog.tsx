import { useNow } from "./useNow";
import type { BacklogModel, BacklogProps } from "./backlog/backlogTypes";
import { useBacklogCuts } from "./backlog/useBacklogCuts";
import { useBacklogDraft } from "./backlog/useBacklogDraft";
import { useBacklogDrag } from "./backlog/useBacklogDrag";
import { useBacklogEdit } from "./backlog/useBacklogEdit";
import { useBacklogFilters } from "./backlog/useBacklogFilters";
import { useBacklogUi } from "./backlog/useBacklogUi";
import { BacklogHead } from "./backlog/RepoBar";
import { BacklogBody } from "./backlog/BacklogBody";

/**
 * **A repo's waiting work — the list, never a place words are "sent to".**
 *
 * Every item here opens its own session when it fires and closes it afterwards;
 * a repo's items still run strictly one at a time, and different repos run
 * independently. What went is the shared `backlog · <repo>` conversation every
 * item used to be appended to — unrelated work in one window for ever, which is
 * the exact shape `shared/sessioncost.ts` measured as three quarters of this
 * desktop's whole token spend.
 *
 * Two things left this sheet with that change, and both were duplicates rather
 * than losses:
 *
 *  - **The add form.** Its own `PromptComposer`, repo select, target-session
 *    select, dictate and three attach buttons — a fifth prompt-writing surface,
 *    asking a different subset of the same four questions. It is now *+ send…*
 *    in the header, which opens the one send sheet seeded to this repo and
 *    *when it's free*, i.e. the same post with every answer reachable.
 *  - **The staged action queue** (`queue` / `queue mode`, the `⊕ fire / check /
 *    validate / continue` buttons and the runner that polled sessions for
 *    idleness). It predates the intent store, which serializes per repo on the
 *    HOST — so a phone-side batch runner was a second scheduler watching the
 *    first one through a keyhole, and it only ran while this tab was awake.
 */

export function Backlog(p: BacklogProps) {
  // ORDER IS BEHAVIOUR: the cut-from-outside effect (filters), then the
  // ticking clock, then the drag binding — as they ran inline.
  const draft = useBacklogDraft();
  const filters = useBacklogFilters(p);
  const ui = useBacklogUi();
  // Ages are rendered, so the clock has to move: a sheet open with nothing
  // arriving would otherwise keep saying "2m ago" half an hour later.
  const now = useNow(30_000);
  const edit = useBacklogEdit(p);
  const cuts = useBacklogCuts(p, now, filters, ui.picked);
  const drag = useBacklogDrag(p, cuts);
  const m: BacklogModel = { p, now, ...draft, ...filters, ...ui, ...edit, ...cuts, ...drag };
  return (
    <div className="sheet">
      <BacklogHead m={m} />

      <BacklogBody m={m} />
    </div>
  );
}
