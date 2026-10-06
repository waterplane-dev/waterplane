/**
 * The `history` overlay: `HistorySheet.tsx` wired to this feature's store —
 * the prop list `App.tsx`'s `overlayViews.history` used to spell out.
 */
import type { SessionInfo } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { HistorySheet } from "../../HistorySheet";
import { history } from "./store";
import { pinEntry, resendToCompose } from "./actions";

export function PromptHistorySheet({ active }: { active: SessionInfo }) {
  const c = useCore();
  const entries = useStore(history).get(active.id) ?? [];
  return (
    <HistorySheet title={active.title} entries={entries}
      pinnedEntryId={active.pinnedEntryId}
      offline={c.conn.status !== "open"}
      onClose={() => c.nav.close("history")}
      onResend={resendToCompose}
      onPin={(entryId) => pinEntry(active.id, entryId)} />
  );
}
