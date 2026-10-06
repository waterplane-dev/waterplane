import { CalendarClock, SendHorizontal, X } from "lucide-react";
import { SheetHead } from "./Sheet";
import { track } from "./usage";
import { ComposeSection } from "./send/ComposeSection";
import { RetimeHint } from "./send/RetimeHint";
import { SendActions } from "./send/SendActions";
import { ToSection } from "./send/ToSection";
import { WhenSection } from "./send/WhenSection";
import { useSendSheet } from "./send/useSendSheet";
import type { SendSheetProps } from "./send/sendSheetTypes";

/**
 * **The one send surface.**
 *
 * Text first, then two collapsed rows — *To* and *When* — pre-filled from
 * wherever the send came from, each expanding in place. The primary button
 * restates the whole decision ("Send to fix-e2e now", "Save for Thu 20:00") and
 * is live the moment there is text; disabled, it says why.
 *
 * The shape is the argument. Twelve entry points each asked a different subset
 * of the same four questions, in a different order, and the ones they did not
 * ask they answered by existing: the compose bar's mode button cycled a hidden
 * per-repo setting, the Start sheet could not queue for later, the pad's four
 * buttons were four destinations with no WHEN at all, and "sequential or
 * parallel" was never asked anywhere — it was a property of the sheet you had
 * opened. Collapsing that into two rows costs a tap for the rare send that
 * wants something unusual, and saves the far more common one from being
 * impossible in the sheet it started in.
 *
 * Every answer is pre-filled and every answer is changeable, which is the half
 * that fixes "I need to select the repo again for which the prompt was meant":
 * a seed carries the `cwd` its words were written against, so the pickers open
 * with that repo first and LABELLED — marked, never preselected, because a
 * message may legitimately be re-aimed.
 */
export function SendSheet(props: SendSheetProps) {
  const m = useSendSheet(props);
  const { retime, onDiscard, onClose } = m;
  return (
    <div className="sheet">
      <SheetHead title={retime ? <><CalendarClock size={16} /> Re-time</> : <><SendHorizontal size={16} /> Send</>} onClose={onClose}>
        {onDiscard && !retime && (
          <button className="key danger" title="throw this message away — the words go too"
            onClick={() => { track("action:send.discard"); onDiscard(); onClose(); }}>
            <X size={16} /> discard
          </button>
        )}
      </SheetHead>

      <div className="sheet-scroll">
        {retime ? (
          <RetimeHint m={m} />
        ) : (<>
          <ComposeSection m={m} />
          <ToSection m={m} />
        </>)}

        <WhenSection m={m} />
      </div>

      <SendActions m={m} />
    </div>
  );
}
