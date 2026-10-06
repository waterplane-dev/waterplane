import { ArchiveRestore, Inbox, SendHorizontal, Square, SquareCheck } from "lucide-react";
import { track } from "../usage";
import type { ActivityModel } from "./useActivityModel";
import type { ActivitySheetProps } from "./activitySheetTypes";

/** The bulk bar under the list: what each of the two decisions would cover. Null when not selecting. */
export function ActivityBulkBar({ m, p }: { m: ActivityModel; p: ActivitySheetProps }) {
  const { selecting, pickedRows, shown, selectVisible, clearSelection, refire, file, restorable, filter } = m;
  if (!selecting) return null;
  return (
    <div className="act-bulk">
      <span className="act-bulk-n">{pickedRows.length} selected</span>
      <button className="key" title={`select all ${shown.length} rows on screen`} onClick={selectVisible}>
        <SquareCheck size={14} /> all {shown.length}
      </button>
      <button className="key" title="clear the selection" disabled={!pickedRows.length} onClick={clearSelection}>
        <Square size={14} /> none
      </button>
      {/* The two decisions the 84 rows are read for. Both restate their count,
          both are confirmed with a sample before anything happens, and both
          are refused WITH A REASON rather than silently greyed. */}
      <button className="key primary" data-hint="activity.bulkRefire"
        disabled={!refire.go.length}
        title={refire.go.length
          ? `send ${refire.go.length} again as backlog items, each in the repo it was written for${refire.skip.length ? ` — ${refire.skip.length} left alone` : ""}`
          : pickedRows.length ? "none of the selected rows can be sent again — each says why on its own row" : "nothing selected"}
        onClick={() => { track("action:activity.bulk.refire"); p.onBulk("refire", refire.go); }}>
        <SendHorizontal size={14} /> send {refire.go.length} again
      </button>
      {filter === "dismissed" ? (
        <button className="key"
          disabled={!restorable.length}
          title={restorable.length ? `put ${restorable.length} back in the list` : "nothing filed is selected"}
          onClick={() => { track("action:activity.bulk.restore"); p.onBulk("restore", restorable); }}>
          <ArchiveRestore size={14} /> bring {restorable.length} back
        </button>
      ) : (
        <button className="key" data-hint="activity.bulkDismiss"
          disabled={!file.go.length}
          title={file.go.length
            ? `file ${file.go.length} away as dealt with — nothing is deleted, and “dismissed” brings them back`
            : pickedRows.length ? "the selected rows are running — stopping one is “cancel”" : "nothing selected"}
          onClick={() => { track("action:activity.bulk.dismiss"); p.onBulk("dismiss", file.go); }}>
          <Inbox size={14} /> file {file.go.length} away
        </button>
      )}
    </div>
  );
}
