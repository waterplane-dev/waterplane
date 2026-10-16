import { useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { SLOT_ASK_CHECK, SLOT_ASK_LATER, SLOT_ASK_OFF, slotAskOffToast, slotAskText, slotCheckTitle } from "./slotCheck";
import { closeSlotAsk, currentSlotAsk, onSlotAsk, openSlotCheck, setSlotAskOff } from "./slotAskStore";
import { baseName } from "./format";
import { showToast } from "./toast";
import { track } from "./usage";

/** How long the card waits for an answer. Unanswered it goes, and the
 *  backlog's *check these N* is still there — nothing is lost by ignoring it. */
const ASK_MS = 60_000;

/**
 * **The slot check's ask** — after a timed send lands beside others: *3 others
 * run at this reset — check them together?* with *check*, *not now* and
 * *don't ask in this repo*.
 *
 * Mounted beside the toast in `main.tsx`, for the toast's reason: `App` returns
 * early once per overlay, and the send that triggers this usually closes the
 * Send sheet onto whatever screen is under it. NOT a modal: no scrim, nothing
 * under it is blocked, and it is not the toast either — a toast goes on any tap
 * and this one has to be answerable. State: `slotAskStore.ts`; words:
 * `slotCheck.ts`.
 */
export function SlotAskLayer() {
  const [, bump] = useState(0);
  useEffect(() => onSlotAsk(() => bump((n) => n + 1)), []);
  const ask = currentSlotAsk();
  useEffect(() => {
    if (!ask) return;
    const t = setTimeout(closeSlotAsk, ASK_MS);
    return () => clearTimeout(t);
  }, [ask]);
  if (!ask) return null;
  const repo = baseName(ask.check.repoDir);
  return (
    <div className="slot-ask" role="status" aria-live="polite">
      <div className="slot-ask-what"><ClipboardCheck size={14} /> {slotAskText(ask)}</div>
      <div className="slot-ask-acts">
        <button className="key primary" title={slotCheckTitle(ask.check)}
          onClick={() => {
            track("action:slotask.check");
            closeSlotAsk();
            if (!openSlotCheck(ask.check)) showToast("the check could not be opened from here — the backlog's check these verb does the same");
          }}>
          {SLOT_ASK_CHECK}
        </button>
        <button className="key" title="leave them as they are — the backlog still offers the check"
          onClick={() => { track("action:slotask.later"); closeSlotAsk(); }}>
          {SLOT_ASK_LATER}
        </button>
        <button className="link-btn" title={`stop offering this after a timed send in ${repo}`}
          onClick={() => { track("action:slotask.off"); setSlotAskOff(ask.check.repoDir, true); showToast(slotAskOffToast(repo)); }}>
          {SLOT_ASK_OFF}
        </button>
      </div>
    </div>
  );
}
