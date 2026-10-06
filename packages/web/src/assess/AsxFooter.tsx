/**
 * The apply bar: what is ticked, Apply, the route to the backlog, and what applying does not do.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { CheckCheck, ListTodo, X } from "lucide-react";
import { assessApplyNote, assessPickedLabel, assessCutLabel, assessOpenBacklogLabel, assessOpenBacklogNote } from "../assessRows";
import { Unavailable } from "../Unavailable";
import { track } from "../usage";
import type { AssessModel } from "./useAssessSheet";

export function AsxFooter({ m }: { m: AssessModel }) {
  const { p, setPickedRows, setPickedMerges, setPickedNews, picked, applyBlocked, apply, applySummary, applyLabel, ready } = m;
  return (
    <>
    <div className="act-bulk">
      {/* `4 ticked`, not `4 accepted`: nothing has been accepted until Apply,
          and "accepted" is the word every control on this screen stopped
          using. */}
      <span className="act-bulk-n">{assessPickedLabel(picked)}</span>
      {/* Drawn only when there is something to clear. A `clear` with nothing
          ticked is a control whose only honest state is "does nothing", and
          greying it is the thing this app does not do. */}
      {picked ? (
        <button className="key" title="un-tick everything — nothing has happened yet, so nothing is undone"
          onClick={() => {
            track("action:assess.clear");
            setPickedRows(new Set<string>()); setPickedMerges(new Set<string>()); setPickedNews(new Set<number>());
          }}>
          <X size={14} /> clear
        </button>
      ) : null}
      {/* **The button restates the whole decision** — `2 retired · 1 kept · 1
          posted in myapp`, not `Apply 4`. It is the last thing read before the
          only irreversible tap on the screen, and "4" is a number somebody has
          to trust rather than a sentence they can check. Where it cannot be
          pressed there is no button: the reason is the sentence instead. */}
      {applyBlocked
        ? <Unavailable cants={[{ label: "apply", reason: applyBlocked }]} />
        : (
          <button className="key primary" title={applyLabel} onClick={apply}>
            <CheckCheck size={14} /> {applyLabel}
          </button>
        )}
      {/* **The route out of this screen, once the apply has happened.**

          Applying wrote the retirements, the order, the merges, the new items
          and the re-queues — and then the sheet said what it had done and
          offered nothing: *"still no button to lead to the groomed backlog with
          the results where I then can kick implementation off"*. This is that
          route and only that. It is drawn AFTER the apply, never instead of it,
          and it mutates nothing: the apply above already happened by tap, and
          nothing on this screen applies itself.

          **The count is the filter** — `assessReadyCut` returns the ids and the
          number is their length, so the `N waiting` on the button and the rows
          that open are one derivation. With none waiting the count is dropped
          and the tap opens the list unfiltered, which is the honest shape of
          "every one of them has already started". */}
      {ready ? (
        <button className="key primary asr-route" title={assessOpenBacklogNote(ready.n)}
          onClick={() => { track("action:assess.backlog"); p.onOpenBacklog?.(ready.ids, assessCutLabel(p.repoName)); }}>
          <ListTodo size={14} /> {assessOpenBacklogLabel(ready.n, p.repoName)}
        </button>
      ) : null}
    </div>
    {/* What applying does NOT do, once, under the button — the answer to
        "accept" reading as "go and build it". It takes the re-queue count,
        because with one this apply DOES cause work to run later and the flat
        "nothing is built or sent by this" would be a promise it cannot keep:
        the sentence then says not-now, one at a time per repo, a session
        each. */}
    <div className="form-hint">{assessApplyNote(applySummary?.requeue ?? 0)}</div>
    {/* The route's own sentence, under it and never only in its `title` — a
        tooltip is invisible on a phone (`Unavailable.tsx`'s rule) and this one
        carries the promise that the tap changes nothing. */}
    {ready ? <div className="form-hint">{assessOpenBacklogNote(ready.n)}</div> : null}
    </>
  );
}
